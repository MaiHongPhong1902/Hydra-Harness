// @vitest-environment jsdom
/** Dedicated generation output preserves lifecycle, gallery, and video controls. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { en as commonEn } from '@hydraharness/harness-client-locale/src/locales/en.ts'
import { en } from '@hydraharness/harness-client-ui-conversation/src/client/locales.ts'
import type { ToolCallBlock } from '@hydraharness/harness-client-runtime/client'
import type { MediaGenerationProps } from '../src/client/contract/slots.ts'
import { MediaGeneration } from '../src/client/tool/MediaGeneration.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = makeTranslate(en, commonEn)
const running = (kind: 'image' | 'video' = 'image'): ToolCallBlock => ({
  callId: 'media-1', name: 'generate', argsRaw: '{}', turn: 1, step: 1, time: 0,
  callView: { card: 'media', kind, title: 'Generate', prompt: 'A tree' }, subCalls: [],
})
const settled = (kind: 'image' | 'video' = 'image'): ToolCallBlock => ({
  ...running(kind), kind: 'tool-result', seq: 2, call: null, callTime: 0,
  content: [{ type: 'text', text: 'Done' }], isError: false,
  resultView: { card: 'media', kind, model: 'selected-model', provider: 'selected-route', content: [] },
})
function props(block: ToolCallBlock): MediaGenerationProps {
  return {
    node: { data: { root: block } }, t,
    renderMessageImages: vi.fn(() => <div data-testid="gallery" />),
    loadMedia: vi.fn(async () => 'blob:video'), inspectCall: vi.fn(), selectedCallId: block.callId,
    loadModelName: vi.fn(async () => undefined),
  } as unknown as MediaGenerationProps
}

it.each(['image', 'video'] as const)('keeps %s pending, complete, failure, and interruption visible', (kind) => {
  const owner = props(running(kind))
  const view = render(<MediaGeneration {...owner} />)
  expect(view.container.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
  expect(view.container.querySelector('[data-media-placeholder]')).toBeTruthy()
  expect(view.getByText('A tree')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'View generation details' }))
  expect(owner.inspectCall).toHaveBeenCalledWith('media-1')
  const result = settled(kind)
  view.rerender(<MediaGeneration {...owner} node={{ ...owner.node, data: { root: result } }} />)
  expect(view.container.querySelector('[data-media-placeholder]')).toBeNull()
  expect(view.container.querySelector('footer')?.textContent).toBe('selected-model')
  const failed = { ...result, isError: true, content: [{ type: 'text', text: 'Provider refused' }] } as ToolCallBlock
  view.rerender(<MediaGeneration {...owner} node={{ ...owner.node, data: { root: failed } }} />)
  expect(screen.getByRole('alert').textContent).toBe('Provider refused')
  view.rerender(<MediaGeneration {...owner} node={{ ...owner.node, data: { root: { ...failed, content: [], error: { name: 'Interrupted', code: 'interrupted' } } } }} />)
  expect(view.container.querySelector('[data-state="interrupted"]')).toBeTruthy()
})

it('renders image references once through the existing gallery', () => {
  const image = { attachmentId: 'image-id', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } as const
  const result = { ...settled(), resultView: { card: 'media', kind: 'image', content: [{ type: 'image', attachment: image }] } } as ToolCallBlock
  const owner = props(result)
  render(<MediaGeneration {...owner} />)
  expect(screen.getByTestId('gallery')).toBeTruthy()
  expect(owner.renderMessageImages).toHaveBeenCalledExactlyOnceWith({ images: [{ attachment: image }], align: 'start', presentation: 'media' })
})

it.each([1, 1.5, 2 / 3, 9 / 16])('sizes the pending preview to the requested ratio %s', (aspectRatio) => {
  const block = running()
  block.callView = { card: 'media', kind: 'image', title: 'Generate', prompt: 'A tree', aspectRatio }
  const view = render(<MediaGeneration {...props(block)} />)
  const placeholder = view.container.querySelector<HTMLElement>('[data-media-placeholder]')!
  expect(placeholder.style.aspectRatio).toBe(`${aspectRatio} / 1`)
  expect(placeholder.style.width).toBe('')
})

it('shows the generated model name and ignores a stale catalog response after switching results', async () => {
  const owner = props(settled())
  let finish!: (name: string) => void
  const loader = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    .mockResolvedValueOnce('Actual fallback model')
  const view = render(<MediaGeneration {...owner} loadModelName={loader} />)
  const fallback = { ...settled(), resultView: { card: 'media', kind: 'image', model: 'fallback-id', provider: 'other-route', content: [] } } as ToolCallBlock
  view.rerender(<MediaGeneration {...owner} loadModelName={loader} node={{ ...owner.node, data: { root: fallback } }} />)
  await screen.findByText('Actual fallback model')
  expect(view.container.querySelector('footer')?.textContent).toBe('Actual fallback model')
  expect(loader).toHaveBeenNthCalledWith(2, 'other-route', 'fallback-id')
  await act(async () => { finish('Stale model') })
  expect(screen.queryByText(/Stale model/)).toBeNull()
})

it('retains the model ID when its catalog is unavailable', async () => {
  const owner = props(settled())
  const loader = vi.fn().mockRejectedValue(new Error('offline'))
  render(<MediaGeneration {...owner} loadModelName={loader} />)
  await waitFor(() => { expect(loader).toHaveBeenCalledWith('selected-route', 'selected-model') })
  expect(screen.getByText('selected-model')).toBeTruthy()
})

it('copies the full prompt with success feedback', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const block = settled()
  render(<MediaGeneration {...props(block)} />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
  await screen.findByRole('button', { name: 'Copied' })
  expect(writeText).toHaveBeenLastCalledWith('A tree')
})

it('loads stored video, permits retry and download, and ignores a departed player', async () => {
  const video = { attachmentId: 'video-id', mediaType: 'video/webm', bytes: 4, name: 'tree.webm' } as const
  const result = { ...settled('video'), resultView: { card: 'media', kind: 'video', content: [{ type: 'video', attachment: video }] } } as ToolCallBlock
  const owner = props(result)
  const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('blob:video')
  const view = render(<MediaGeneration {...owner} loadMedia={loader} />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(view.container.querySelector('video')?.getAttribute('src')).toBe('blob:video') })
  expect(view.container.querySelector('video')?.hasAttribute('autoplay')).toBe(false)
  expect(screen.getByRole('link', { name: 'Download video' }).getAttribute('download')).toBe('tree.webm')
  fireEvent.error(view.container.querySelector('video')!)
  expect(screen.getByRole('alert').textContent).toContain('Video failed to load')
  view.unmount()
  let resolve!: (url: string) => void
  const departed = render(<MediaGeneration {...owner} loadMedia={() => new Promise<string>((done) => { resolve = done })} />)
  departed.unmount()
  resolve('blob:late')
  let reject!: (error: Error) => void
  const rejected = render(<MediaGeneration {...owner} loadMedia={() => new Promise<string>((_done, fail) => { reject = fail })} />)
  rejected.unmount()
  reject(new Error('late failure'))
})

it('preserves result-only output and an empty error without assuming call metadata', () => {
  const result = { ...settled(), callView: null, resultView: null, content: [], isError: true } as ToolCallBlock
  render(<MediaGeneration {...props(result)} />)
  expect(screen.getByRole('alert').textContent).toBe('Image generation failed')
})
