// @vitest-environment jsdom
/** ToolCallTree-owned root/subcall markers and selection projection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { HostDescription } from '@hydraharness/harness-client-connection/client'
import type { ConversationSnapshot, ToolResultNode } from '@hydraharness/harness-client-runtime/client'
import { makeTranslate } from '@hydraharness/harness-client-test-runtime'
import { en as commonEn } from '@hydraharness/harness-client-locale/src/locales/en.ts'
import type { ToolTreeProps } from '../src/client/contract/slots.ts'
import { ToolCallTree } from '../src/client/tool/ToolCallTree.tsx'
import { en } from '@hydraharness/harness-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

const t: ToolTreeProps['t'] = makeTranslate(en, commonEn)

const root = (callId: string, call: ToolResultNode['call']): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 3_000, callId, call, callTime: 2_000,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})

function props(
  block: ToolResultNode,
  selectedCallId?: string,
  description?: HostDescription,
): ToolTreeProps {
  const snapshot = {} as ConversationSnapshot
  const useSession = ((selector: (value: ConversationSnapshot) => unknown) => selector(snapshot)) as ToolTreeProps['useSession']
  const renderSlot = ((_key: string, _owner: object, options?: { fallback?: React.ReactNode }) =>
    options?.fallback ?? null) as unknown as ToolTreeProps['renderSlot']
  return {
    useSession,
    renderSlot,
    renderMessageImages: vi.fn(() => null),
    node: {
      key: `tool:${block.callId}`,
      kind: 'tool-call',
      id: block.callId,
      target: 'chat',
      anchorSeq: block.seq,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { root: block },
    },
    selectedCallId,
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    fileMentions: vi.fn(),
    useHostDescription: (selector => selector(description)) as ToolTreeProps['useHostDescription'],
    t,
  } as unknown as ToolTreeProps
}

describe('ToolCallTree', () => {
  it('renders durable presentation images for root and nested results through the conversation owner', () => {
    const image = { attachmentId: 'opaque-image', mediaType: 'image/png', bytes: 68, width: 1, height: 1 } as const
    const leaf = { ...root('image:child', null), resultView: { card: 'generic', content: [{ type: 'image', attachment: image }] } } as ToolResultNode
    const block = { ...leaf, callId: 'image', subCalls: [leaf] }
    const owner = props(block)
    render(<ToolCallTree {...owner} />)
    expect(owner.renderMessageImages).toHaveBeenCalledTimes(2)
    expect(owner.renderMessageImages).toHaveBeenCalledWith({ images: [{ attachment: image }], align: 'start' })
  })

  it('does not show image previews for a failed result or text-only presentation', () => {
    const block = root('image', null)
    const owner = props(block)
    const view = render(<ToolCallTree {...owner} />)
    view.rerender(<ToolCallTree {...owner} node={{ ...owner.node, data: { root: { ...block, isError: true } } }} />)
    view.rerender(<ToolCallTree {...owner} node={{ ...owner.node, data: { root: { ...block, resultView: { card: 'generic', content: [{ type: 'text', text: 'Done' }] } } } }} />)
    expect(owner.renderMessageImages).not.toHaveBeenCalled()
  })
  it('owns the root marker, generic fallback, and selected state for a window-truncated call', () => {
    const block = root('w1', null)
    const view = render(<ToolCallTree {...props(block, 'w1')} />)
    const row = view.container.querySelector('[data-chat-call-id="w1"]')
    expect(row?.getAttribute('data-chat-anchor-key')).toBe('call:w1')
    expect(row?.getAttribute('data-selected')).toBe('true')
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.getByText('w1')).toBeTruthy()
  })

  it('recursively renders a selected leaf without selecting its ancestors', () => {
    const leaf = root('parent:code:1:code:1', { name: 'read', argsRaw: '{"path":"a.ts"}' })
    const child = {
      ...root('parent:code:1', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [leaf],
    }
    const block = {
      ...root('parent', { name: 'run_code', argsRaw: '{"code":"return 1"}' }),
      subCalls: [child],
    }
    const view = render(<ToolCallTree {...props(block, leaf.callId)} />)
    const nests = view.container.querySelectorAll('[data-subcalls]')
    expect(nests[0]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent"]'))
    expect(nests[1]?.parentElement).toBe(view.container.querySelector('[data-chat-call-id="parent:code:1"]'))
    expect(view.container.querySelector('[data-chat-call-id="parent"]')?.hasAttribute('data-selected')).toBe(false)
    expect(view.container.querySelector('[data-chat-call-id="parent:code:1"]')?.hasAttribute('data-selected')).toBe(false)
    expect(view.container.querySelector('[data-chat-call-id="parent:code:1:code:1"]')?.getAttribute('data-selected')).toBe('true')
    expect(nests).toHaveLength(2)
  })

  it('abbreviates a POSIX home path in the generic tool summary', () => {
    const block = root('w1', { name: 'read', argsRaw: '{"path":"/h/docs/a.ts"}' })
    const view = render(<ToolCallTree {...props(block, 'w1', {
      version: '0', cwd: '/tmp', attachedSessions: 0, home: '/h', canOpenPath: false,
    })} />)
    expect(view.getByText('~/docs/a.ts')).toBeTruthy()
  })
})
