/** Video storage bounds, credential-independent routing, and shared media disposal. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { CallId, type MediaGenerationOptions } from '@hydraharness/harness-llm'
import Tools, { type ToolExecutionToken } from '@hydraharness/harness-tools'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import AttachmentStore from '@hydraharness/harness-attachment-local'
import Credentials from '@hydraharness/harness-credentials-local'
import { toolVideoReferences } from '@hydraharness/harness-attachment'
import * as Media from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function harness(config: Media.Config = {}, response?: () => Response | undefined) {
  const home = await mkdtemp(join(tmpdir(), 'hydra-tool-media-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AttachmentStore, { hydraHome: home })
  await ctx.plugin(Credentials, { path: join(home, 'credentials.yml'), hydraHome: home, watch: false })
  const calls: MediaGenerationOptions[] = []
  if (response !== undefined) ctx.provide('llm', { generateMedia: async (options: MediaGenerationOptions) => {
    calls.push(options)
    const body = response()
    return body === undefined ? undefined : { provider: 'fixture', model: 'video-fixture', response: body }
  } } as never)
  const fiber = await ctx.plugin(Media, config)
  return { ctx, fiber, calls, call: (args: unknown = { prompt: 'A tree' }, signal = new AbortController().signal, parent?: ToolExecutionToken) =>
    ctx.tools.execute({ name: 'video_generate', callId: CallId('video-test'), arguments: args, signal, ...parent === undefined ? {} : { parent } }) }
}

it('stores exact video bytes, labels the accepted route, and disposes every media tool', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const h = await harness({ video: { provider: 'fixture', model: 'hint', maxVideoBytes: 3, pollIntervalMs: 1 } }, () => new Response(bytes, { headers: { 'Content-Type': 'video/webm; charset=binary' } }))
  const result = await h.call({ prompt: 'A tree', seconds: 6, size: '720x1280' })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: 'Generated video with fixture (video-fixture).' }])
  expect(h.calls).toMatchObject([{ endpoint: 'videos', provider: 'fixture', model: 'hint', body: { prompt: 'A tree', seconds: 6, size: '720x1280' }, pollIntervalMs: 1 }])
  const videos = toolVideoReferences(result.meta)
  expect(videos).toMatchObject([{ bytes: 3, mediaType: 'video/webm', name: 'generated-video.webm' }])
  const stored: number[] = []
  for await (const chunk of h.ctx.attachments.readFileStream(videos[0]!)) stored.push(...chunk)
  expect(stored).toEqual([...bytes])
  const tool = h.ctx.tools.get('video_generate')!
  expect(tool.presentCall?.({ prompt: 'A tree', size: '720x1280' })).toMatchObject({ aspectRatio: 9 / 16 })
  expect(tool.presentCall?.({ prompt: 'A tree', size: '1280x720' })).toMatchObject({ aspectRatio: 16 / 9 })
  expect(tool.presentCall?.({ prompt: 'A tree' })).not.toHaveProperty('aspectRatio')
  expect(tool.presentResult?.({ prompt: 'A tree' }, result)).toMatchObject({ card: 'media', kind: 'video', content: [{ type: 'video', attachment: videos[0] }] })
  expect(tool.presentResult?.({ prompt: 'A tree' }, { content: [], isError: true })).toBeUndefined()
  await h.fiber.dispose()
  for (const name of ['image_generate', 'image_generate_google', 'video_generate']) expect(h.ctx.tools.get(name)).toBeUndefined()
})

it('uses MP4 naming and default request fields', async () => {
  const h = await harness({}, () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }))
  const result = await h.call()
  expect(toolVideoReferences(result.meta)[0]?.name).toBe('generated-video.mp4')
  expect(h.calls).toMatchObject([{ body: { prompt: 'A tree' }, pollIntervalMs: 10000, maxResponseBytes: 1048576 }])
})

it.each([
  [() => Response.json({ id: 'pending-job' }), 'completed MP4 or WebM'],
  [() => new Response(null, { headers: { 'Content-Type': 'video/mp4' } }), 'no video bytes'],
  [() => new Response(new Uint8Array(), { headers: { 'Content-Type': 'video/mp4' } }), 'Unable to persist attachment'],
  [() => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'video/mp4' } }), 'Unable to persist attachment'],
] as const)('publishes no references for invalid or oversized video response %#', async (reply, error) => {
  const h = await harness({ video: { maxVideoBytes: 3 } }, reply)
  const result = await h.call()
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain(error)
  expect(toolVideoReferences(result.meta)).toEqual([])
  expect(h.calls).toHaveLength(1)
})

it.each([undefined, () => undefined])('requires a configured video route %#', async (reply) => {
  const h = await harness({}, reply)
  expect(JSON.stringify((await h.call()).content)).toContain('Configure a video model')
})

it.each([{ timeoutMs: 0 }, { pollIntervalMs: -1 }, { maxVideoBytes: 0 }, { maxResponseBytes: 0 }, { maxPromptChars: 0 }, { model: '' }, { provider: '' }, { timeoutMs: 2147483648 }, { pollIntervalMs: 2147483648 }])('rejects invalid video settings %j', async (video) => {
  await expect(harness({ video })).rejects.toThrow()
})

it('rejects invalid prompts and prior cancellation before generation', async () => {
  const h = await harness({ video: { maxPromptChars: 3 } }, () => Response.json({}))
  for (const prompt of [' ', 'long']) expect((await h.call({ prompt })).isError).toBe(true)
  const controller = new AbortController()
  controller.abort()
  expect((await h.call({ prompt: 'ok' }, controller.signal)).isError).toBe(true)
  expect(h.calls).toEqual([])
})

it('refuses nested execution before submitting a billable video request', async () => {
  const h = await harness({}, content)
  const result = await h.call(undefined, undefined, Symbol('parent') as ToolExecutionToken)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('requires Native tool mode')
  expect(h.calls).toEqual([])
})

function content(): Response {
  return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } })
}
