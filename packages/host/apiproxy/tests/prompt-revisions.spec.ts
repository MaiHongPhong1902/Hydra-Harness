import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@hydraharness/cordis'
import AgentRegistry, { Inbox, type Agent, type CreateAgentOptions } from '@hydraharness/harness-agent'
import { createUserMessage, type ContentBlock } from '@hydraharness/harness-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@hydraharness/harness-session'
import { WorkspaceId } from '@hydraharness/harness-workspace'
import { createPromptReviser } from '../src/prompt-revisions.ts'
import type { ConversationRevision, PromptRevisionRequest } from '../src/api/sessions.ts'

type Dependencies = Parameters<typeof createPromptReviser>[1]
type Source = Awaited<ReturnType<Dependencies['read']>>
const sourceId = SessionId('original')
const workspaceId = WorkspaceId('project')
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]
const request = (edit: PromptRevisionRequest['edit'] = { messageSeq: 1, text: 'edited' }): PromptRevisionRequest => ({
  sessionId: sourceId, workspaceId, idempotencyKey: 'operation', ...edit === undefined ? {} : { edit },
})

function user(content: ContentBlock[], seq: number): SessionEvent {
  return { type: 'user/message', seq, time: seq, surfaceOp: 'append', data: createUserMessage({ content, source: { kind: 'user' } }) }
}

function revision(message = createUserMessage({ content: text('admitted'), source: { kind: 'user' } })): ConversationRevision {
  return {
    sessionId: sourceId, conversationId: sourceId, previousSessionId: sourceId, turn: 1, createdAt: 1,
    admission: { fingerprint: 'previous', messageId: message.id, message: { ...message, content: [{ type: 'text', text: 'admitted' }], source: { kind: 'user' } } },
  }
}

async function harness() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const source: Source = {
    id: sourceId, header: { id: sourceId, version: 0, createdAt: 0, cwd: '/project' },
    events: [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      user(text('original'), 1),
      { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  const calls: string[] = []
  const workspace = { id: workspaceId, sessionIds: [sourceId], attachSession: vi.fn(async (_id: SessionId) => { calls.push('attach') }) }
  ctx.provide('workspaceRegistry', { list: () => [workspace] } as never)
  const readImage = vi.fn(async () => ({ data: new Uint8Array(5) }))
  const imageLimits = { maxImagesPerMessage: 2, maxMessageImageBytes: 10 }
  ctx.provide('attachments', { readImage, imageLimits } as never)
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => { calls.push('flush'); return true })
  function agent(session: Session): Agent {
    const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
    return {
      id: session.id, session, ctx, inbox, status: 'idle',
      send: vi.fn<Agent['send']>((message, target) => { calls.push('park'); inbox.append(target, message) }),
      followup: vi.fn(() => { calls.push('followup') }),
      cancel: vi.fn(), whenIdle: vi.fn(async () => undefined),
    } as unknown as Agent
  }
  const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async (options: CreateAgentOptions) => {
    const session = ctx.sessions.create(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: [...options.seed] },
      ...options.meta === undefined ? {} : { meta: options.meta },
    })
    const created = agent(session)
    ctx.agents.register(created)
    return { agent: created, dispose: async () => undefined }
  })
  const deps = {
    retain: vi.fn<Dependencies['retain']>(), read: vi.fn(async () => source),
    find: vi.fn<Dependencies['find']>(async (id) => {
      const session = ctx.sessions.get(id)
      return session === undefined ? undefined : { id, header: session.header, events: [...session.events] }
    }),
    compose: vi.fn<Dependencies['compose']>(async () => ({ agentOptions: {} })),
    resume: vi.fn<Dependencies['resume']>(), validateModel: vi.fn<Dependencies['validateModel']>(async () => undefined),
  }
  return { ctx, source, deps, create, workspace, flush, readImage, imageLimits, calls, agent, revise: createPromptReviser(ctx, deps) }
}

it('persists an immutable edit before attaching and waking exactly one child', async () => {
  const h = await harness()
  const before = structuredClone(h.source)
  const pending = h.revise(request())
  expect(h.revise(request())).toBe(pending)
  await expect(h.revise({ ...request(), edit: { messageSeq: 1, text: 'conflict' } })).rejects.toThrow('idempotency key')
  const result = await pending
  expect(h.source).toEqual(before)
  expect(result.sessionId).toMatch(/^session-edit-[a-f0-9]{64}$/u)
  expect(result.revision).toMatchObject({
    conversationId: sourceId, previousSessionId: sourceId, turn: 1, revisionId: result.sessionId, attempt: 1,
  })
  const child = h.ctx.agents.get(result.sessionId)!
  expect(child.session.header).toMatchObject({ cwd: '/project', parentSession: sourceId, seedLength: 1 })
  expect(child.session.events[0]).toMatchObject({ type: 'session/revision', data: result.revision })
  expect(child.inbox.nextTurn).toEqual([])
  expect(h.calls).toEqual(['park', 'flush', 'attach', 'followup'])
  expect(h.deps.retain).toHaveBeenCalledOnce()
  child.session.append('turn/start', { turn: 1 })
  await expect(h.revise(request())).resolves.toEqual(result)
  expect(h.create).toHaveBeenCalledOnce()
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(1)
  await expect(h.revise({ ...request(), edit: { messageSeq: 1, text: 'other' } })).rejects.toThrow('idempotency key')
})

it('recovers a durable parked admission after an attachment failure', async () => {
  const h = await harness()
  h.workspace.attachSession.mockRejectedValueOnce(new Error('workspace offline'))
  await expect(h.revise(request())).rejects.toThrow('workspace offline')
  const child = h.deps.retain.mock.calls[0]![0].agent
  expect(child.inbox.nextTurn).toHaveLength(1)
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(0)
  await h.revise(request())
  expect(h.calls.filter(call => call === 'park')).toHaveLength(1)
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(1)
  expect(child.inbox.nextTurn).toEqual([])
})

it('resumes a cold admission and avoids restarting an already attempted live log', async () => {
  const h = await harness()
  const result = await h.revise(request())
  const child = h.ctx.agents.get(result.sessionId)!
  h.deps.resume.mockResolvedValue(child)
  vi.spyOn(h.ctx.agents, 'get').mockReturnValue(undefined)
  await h.revise(request())
  expect(h.deps.resume).toHaveBeenCalledWith(result.sessionId)
  const snapshot = { id: child.id, header: child.session.header, events: [...child.session.events] }
  h.deps.find.mockResolvedValue(snapshot)
  child.session.append('turn/start', { turn: 1 })
  await h.revise(request())
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(2)
})

it('keeps the latest model header, title and composition while cutting a prior turn', async () => {
  const h = await harness()
  h.source.events.push(
    { type: 'request/header', seq: 3, time: 3, data: { header: { config: { provider: 'fixture', model: 'test' } }, reason: 'initial' } },
    { type: 'session/title', seq: 4, time: 4, data: { title: 'title' } } as SessionEvent,
  )
  const original = h.agent(h.ctx.sessions.create(sourceId))
  h.ctx.agents.register(original)
  h.deps.compose.mockResolvedValue({ agentOptions: {}, agentPreset: 'custom', setup: async () => undefined })
  const result = await h.revise(request())
  const child = h.ctx.agents.get(result.sessionId)!
  expect(original.status).toBe('idle')
  expect(child.session.header.agentPreset).toBe('custom')
  expect(child.session.events.slice(0, 3).map(event => event.type)).toEqual(['request/header', 'session/revision', 'session/title'])
  expect(h.create.mock.calls[0]![0].setup).toBeDefined()
})

it('balances an interrupted turn before revising a steering prompt', async () => {
  const h = await harness()
  h.source.events.splice(2, 1, { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 0 } }, user(text('steer'), 3))
  const result = await h.revise(request({ messageSeq: 3, text: 'revised steering' }))
  expect(result.revision.turn).toBe(2)
  expect(h.ctx.sessions.get(result.sessionId)!.events.slice(0, 6).map(event => event.type)).toEqual([
    'turn/start', 'user/message', 'step/start', 'step/end', 'turn/end', 'session/revision',
  ])
})

it.each(['subagent', 'workspace', 'missing', 'non-user', 'no-turn', 'ended-turn', 'unsupported', 'empty'])('rejects %s edits before creating a child', async (invalid) => {
  const h = await harness()
  const input = request()
  let error = ''
  switch (invalid) {
    case 'subagent': h.source.header = { ...h.source.header, origin: 'subagent' }; error = 'Subagent messages'; break
    case 'workspace': input.workspaceId = WorkspaceId('other'); error = 'addressed workspace'; break
    case 'missing': input.edit = { messageSeq: 99, text: 'edit' }; error = 'not a user message'; break
    case 'non-user': h.source.events[1] = { ...user(text('tool'), 1), data: createUserMessage({ content: text('tool'), source: { kind: 'tool', callId: 'call' as never } }) } as SessionEvent; error = 'not a user message'; break
    case 'no-turn': h.source.events.shift(); error = 'no owning turn'; break
    case 'ended-turn': h.source.events.push(user(text('late'), 3)); input.edit = { messageSeq: 3, text: 'edit' }; error = 'no owning turn'; break
    case 'unsupported': h.source.events[1] = user([{ type: 'file', attachment: {} } as ContentBlock], 1); error = 'cannot preserve'; break
    case 'empty': input.edit = { messageSeq: 1, text: '  ' }; error = 'Enter a message'; break
  }
  await expect(h.revise(input)).rejects.toThrow(error)
  expect(h.create).not.toHaveBeenCalled()
})

const imageBlock = { type: 'image', attachment: { attachmentId: 'image' as never, mediaType: 'image/png', bytes: 5, width: 1, height: 1 } } satisfies ContentBlock
it('preserves image-only prompts and checks both count and byte budgets', async () => {
  const h = await harness()
  h.source.events[1] = user([imageBlock], 1)
  const result = await h.revise(request({ messageSeq: 1, text: '' }))
  expect(result.revision.admission!.message.content).toEqual([imageBlock, { type: 'text', text: '' }])
  expect(h.deps.validateModel).toHaveBeenCalledWith(h.source, true)
  expect(h.readImage).toHaveBeenCalledWith(imageBlock.attachment)
  h.source.events[1] = user([imageBlock, imageBlock, imageBlock], 1)
  await expect(h.revise({ ...request(), idempotencyKey: 'count' })).rejects.toThrow('Too many images')
  h.source.events[1] = user([imageBlock], 1)
  h.readImage.mockResolvedValue({ data: new Uint8Array(11) })
  await expect(h.revise({ ...request(), idempotencyKey: 'bytes' })).rejects.toThrow('byte limit')
})

it.each(['error', 'aborted', 'interrupted', 'blocked', 'unstarted'] as const)('retries %s attempts with the same revision identity and prompt', async (reason) => {
  const h = await harness()
  const previous = revision()
  h.source.header = { ...h.source.header, seedLength: 1 }
  h.source.events = [{ type: 'session/revision', seq: 0, time: 0, data: previous, ignorable: true }]
  if (reason !== 'unstarted') h.source.events.push(
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: previous.admission!.message },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: reason } } } as SessionEvent,
  )
  const result = await h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })
  expect(result.revision).toMatchObject({ previousSessionId: sourceId, revisionId: sourceId, attempt: 2, createdAt: previous.createdAt })
  expect(result.revision.admission!.message).toEqual(previous.admission!.message)
})

it.each(['no-receipt', 'inherited', 'no-admission', 'later-user', 'completed', 'running'])('rejects retry with %s state', async (state) => {
  const h = await harness()
  const previous = revision()
  h.source.header = { ...h.source.header, seedLength: 1 }
  h.source.events = [{ type: 'session/revision', seq: 0, time: 0, data: previous, ignorable: true }]
  let error = 'no admitted prompt revision'
  switch (state) {
    case 'no-receipt': h.source.events = []; break
    case 'inherited': previous.sessionId = SessionId('parent'); break
    case 'no-admission': delete previous.admission; break
    case 'later-user': h.source.events.push(user(text('later'), 1)); error = 'later user prompt'; break
    case 'completed': h.source.events.push({ type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }); error = 'Only a failed'; break
    case 'running': vi.spyOn(h.ctx.agents, 'get').mockReturnValue({ status: 'running' } as Agent); error = 'Only a failed'; break
  }
  await expect(h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'retry' })).rejects.toThrow(error)
  expect(h.create).not.toHaveBeenCalled()
})

it('admits unassigned sessions without inventing a workspace or cwd', async () => {
  const h = await harness()
  h.workspace.sessionIds = []
  h.source.header = { id: sourceId, version: 0, createdAt: 0 }
  const result = await h.revise({ ...request(), workspaceId: null })
  const child = h.ctx.agents.get(result.sessionId)!
  expect(child.session.header.cwd).toBeUndefined()
  expect(h.workspace.attachSession).not.toHaveBeenCalled()
  const existing = { id: result.sessionId, header: { ...child.session.header }, events: [...child.session.events] }
  delete existing.header.seedLength
  h.deps.find.mockResolvedValue(existing)
  await h.revise({ ...request(), workspaceId: null })
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(2)
  h.deps.find.mockResolvedValue({ id: result.sessionId, header: { ...existing.header, parentSession: sourceId }, events: [] })
  await expect(h.revise({ ...request(), workspaceId: null })).rejects.toThrow('idempotency key')
})

it('retains an existing header and title in the prefix and preserves revision lineage', async () => {
  const h = await harness()
  const previous = { ...revision(), revisionId: SessionId('first-revision'), attempt: 2 }
  h.source.events = [
    { type: 'session/revision', seq: 0, time: 0, data: previous, ignorable: true },
    { type: 'request/header', seq: 1, time: 1, data: { header: { config: { provider: 'fixture', model: 'test' } }, reason: 'initial' } },
    { type: 'session/title', seq: 2, time: 2, data: { title: 'kept' } } as SessionEvent,
    { type: 'turn/start', seq: 3, time: 3, data: { turn: 1 } },
    user(text('original'), 4),
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const result = await h.revise(request({ messageSeq: 4, text: 'edit again' }))
  expect(result.revision.previousSessionId).toBe(previous.revisionId)
  const events = h.ctx.sessions.get(result.sessionId)!.events
  expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
  expect(events.filter(event => event.type === 'session/title')).toHaveLength(1)
})

it('validates retained retry images before starting another attempt', async () => {
  const h = await harness()
  const previous = { ...revision(), revisionId: SessionId('first-revision'), attempt: 3 }
  previous.admission!.message.content.unshift(imageBlock)
  h.source.events = [{ type: 'session/revision', seq: 0, time: 0, data: previous, ignorable: true }]
  const result = await h.revise({ sessionId: sourceId, workspaceId, idempotencyKey: 'image-retry' })
  expect(h.readImage).toHaveBeenCalledExactlyOnceWith(imageBlock.attachment)
  expect(result.revision).toMatchObject({ revisionId: previous.revisionId, attempt: 4 })
})

it('does not restart a restored child whose first turn was already admitted', async () => {
  const h = await harness()
  const result = await h.revise(request())
  const child = h.ctx.agents.get(result.sessionId)!
  const started = { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent
  const header = { ...child.session.header }
  delete header.seedLength
  const snapshot = { id: child.id, header, events: [child.session.events[0]!, started] }
  const resumed = h.agent({
    id: child.id, events: [started], header,
  } as unknown as Session)
  h.deps.find.mockResolvedValue(snapshot)
  h.deps.resume.mockResolvedValue(resumed)
  await h.revise(request())
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(1)
  snapshot.events.pop()
  vi.spyOn(h.ctx.agents, 'get').mockReturnValue(undefined)
  await h.revise(request())
  expect(h.deps.resume).toHaveBeenCalledExactlyOnceWith(child.id)
  expect(h.calls.filter(call => call === 'followup')).toHaveLength(1)
})
