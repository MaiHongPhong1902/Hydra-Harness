import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@hydraharness/cordis'
import SessionStore, { ORIGINAL_SESSION_VERSION, SessionVersionId } from '@hydraharness/harness-session'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import { CallId, createUserMessage } from '@hydraharness/harness-llm'
import type { Agent } from '@hydraharness/harness-agent'
import * as VersionTools from '../src/index.ts'

it('lists and reads bounded pages from the calling session without changing its selected path', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(VersionTools, { maxReferenceBytes: 256, catalogPageSize: 1 })
  const session = ctx.sessions.create()
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original 🐉'.repeat(60) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const versionId = SessionVersionId('edited')
  session.append('session/version', { versionId, parentVersionId: ORIGINAL_SESSION_VERSION, beforeSeq: 0 })
  session.append('step/start', { turn: 1, step: 1 })
  const agent = { id: session.id, session } as unknown as Agent
  let count = 0
  const call = (name: string, args: unknown, caller: Agent | null = agent) => ctx.tools.execute({ name, arguments: args,
    callId: CallId(`read-${++count}`), signal: new AbortController().signal, ...caller === null ? {} : { agent: caller } })
  const list = await call('session_version_list', {})
  expect(list.isError).toBe(false)
  expect(list.content).toEqual([{ type: 'text', text: JSON.stringify({ current: versionId, versions: [ORIGINAL_SESSION_VERSION], next_offset: 1 }) }])
  const page = await call('session_version_read', { version_id: ORIGINAL_SESSION_VERSION })
  expect(page.isError).toBe(false)
  const text = page.content.map(block => block.type === 'text' ? block.text : '').join('')
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(256)
  expect(text).toContain('original 🐉')
  expect(text).toContain('Next offset:')
  expect(session.versions.current).toBe(versionId)
  expect((await call('session_version_read', { version_id: 'missing' })).isError).toBe(true)
  expect((await call('session_version_read', { version_id: ORIGINAL_SESSION_VERSION, offset: -1 })).isError).toBe(true)
  expect((await call('session_version_list', { offset: -1 })).isError).toBe(true)
  expect((await call('session_version_list', { offset: 1 })).content)
    .toEqual([{ type: 'text', text: JSON.stringify({ current: versionId, versions: [versionId], next_offset: null }) }])
  expect((await call('session_version_list', {}, null)).isError).toBe(true)
  expect((await call('session_version_read', { version_id: ORIGINAL_SESSION_VERSION }, null)).isError).toBe(true)
  const catalog = ctx.tools.get('session_version_list')
  const reader = ctx.tools.get('session_version_read')
  expect(catalog?.isConcurrencySafe?.({})).toBe(true)
  expect(reader?.isConcurrencySafe?.({ version_id: ORIGINAL_SESSION_VERSION })).toBe(true)
  expect(catalog?.presentCall?.({})?.title).toBe('List prompt versions')
  expect(reader?.presentCall?.({ version_id: ORIGINAL_SESSION_VERSION })?.title).toBe('Read prompt version original')
  await fiber.dispose()
  expect(ctx.tools.get('session_version_read')).toBeUndefined()
  expect(ctx.tools.get('session_version_list')).toBeUndefined()
  expect(() => { VersionTools.apply(ctx, { maxReferenceBytes: 255 }) }).toThrow('Invalid session version read limits')
  expect(() => { VersionTools.apply(ctx, { catalogPageSize: 0 }) }).toThrow('Invalid session version read limits')
  VersionTools.apply(ctx, {})
  expect((await call('session_version_list', {})).isError).toBe(false)
})
