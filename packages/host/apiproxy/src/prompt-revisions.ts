/** Immutable prompt revisions and generation attempts over the existing session log. */
import { createHash } from 'node:crypto'
import type { Context } from '@hydra1902/cordis'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@hydra1902/harness-agent'
import { createUserMessage } from '@hydra1902/harness-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@hydra1902/harness-session'
import { interruptedTurnClosers } from '@hydra1902/harness-session'
import type { Workspace } from '@hydra1902/harness-workspace'
import type { ConversationRevision, PromptRevisionRequest, RevisionMessage } from './api/sessions.ts'
import { conversationRevisionSchema } from './api/sessions.schema.ts'

type Source = { id: SessionId; header: SessionHeader; events: SessionEvent[] }
type Receipt = { sessionId: SessionId; revision: ConversationRevision }

/** Dependencies owned by the Host's session visibility and preset composition. */
interface PromptRevisionDependencies {
  retain(handle: AgentHandle): void
  read(id: SessionId): Promise<Source>
  find(id: SessionId): Promise<Source | undefined>
  compose(source: Source): Promise<Pick<CreateAgentOptions, 'setup'> & { agentOptions: AgentOptions; agentPreset?: string }>
  resume(id: SessionId): Promise<Agent>
  validateModel(source: Source, images: boolean): Promise<void>
}

function ownRevision(source: Source): { revision: ConversationRevision; seq: number } | undefined {
  const event = source.events.findLast(event => event.type === 'session/revision')
  if (event === undefined) return undefined
  const revision = conversationRevisionSchema.parse(event.data)
  return revision.sessionId === source.id ? { revision, seq: event.seq } : undefined
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Build a Host-owned admission function. Only in-flight operations remain in memory;
 * durable receipts resolve retries after reconnect or restart.
 * @param ctx - Composed Host services.
 * @param deps - Source lookup and existing preset/model policy.
 * @returns Edit/retry admission, resolving after the prompt is durable and generation is started.
 */
export function createPromptReviser(ctx: Context, deps: PromptRevisionDependencies): (input: PromptRevisionRequest) => Promise<Receipt> {
  const pending = new Map<SessionId, { fingerprint: string; promise: Promise<Receipt> }>()

  async function admit(input: PromptRevisionRequest, childId: SessionId, fingerprint: string): Promise<Receipt> {
    const source = await deps.read(input.sessionId)
    if (source.header.origin === 'subagent') throw new Error('Subagent messages must be controlled by their owning session.')
    const workspace = ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(source.id))
    if ((workspace?.id ?? null) !== input.workspaceId) throw new Error('The message does not belong to the addressed workspace.')
    const existing = await deps.find(childId)
    if (existing !== undefined) {
      const revision = ownRevision(existing)?.revision
      if (existing.header.parentSession !== source.id || revision?.admission?.fingerprint !== fingerprint) {
        throw new Error('This idempotency key has already been used for a different edit.')
      }
      await workspace?.attachSession(childId)
      const attempted = existing.events.some(event => event.type === 'turn/start' && event.seq >= (existing.header.seedLength ?? 0))
      if (!attempted) await start(ctx.agents.get(childId) ?? await deps.resume(childId), revision.admission.message, workspace)
      return { sessionId: childId, revision }
    }

    const receipt = ownRevision(source)
    const previous = receipt?.revision
    let seed: SessionEvent[]
    let message: RevisionMessage
    let turn: number
    if (input.edit !== undefined) {
      const { messageSeq, text } = input.edit
      const original = source.events.find(event => event.seq === messageSeq)
      if (original?.type !== 'user/message' || original.data.source.kind !== 'user') {
        throw new Error('The selected event is not a user message in this conversation.')
      }
      const opening = source.events.findLast(event => event.type === 'turn/start' && event.seq < messageSeq)
      if (opening?.type !== 'turn/start' || source.events.some(event => event.seq > opening.seq && event.seq < messageSeq && event.type === 'turn/end')) {
        throw new Error('The selected user prompt has no owning turn.')
      }
      if (original.data.content.some(block => block.type !== 'text' && block.type !== 'image')) {
        throw new Error('This prompt contains content that the editor cannot preserve.')
      }
      const retained = original.data.content.filter(block => block.type === 'image')
      if (text.trim() === '' && retained.length === 0) throw new Error('Enter a message.')
      await deps.validateModel(source, retained.length > 0)
      if (retained.length > 0) {
        const limits = ctx.attachments.imageLimits
        if (retained.length > limits.maxImagesPerMessage) throw new Error('Too many images in this prompt.')
        const stored = await Promise.all(retained.map(block => ctx.attachments.readImage(block.attachment)))
        const bytes = stored.reduce((sum, image) => sum + image.data.byteLength, 0)
        if (bytes > limits.maxMessageImageBytes) throw new Error('Images exceed the message byte limit.')
      }
      const content: RevisionMessage['content'] = [
        ...retained,
        { type: 'text', text },
      ]
      message = { ...createUserMessage({ content, source: { kind: 'user' } }), content, source: { kind: 'user' } }
      const steering = source.events.some(event => event.seq > opening.seq && event.seq < messageSeq
        && event.type === 'user/message' && event.data.source.kind === 'user')
      turn = opening.data.turn + Number(steering)
      seed = source.events.slice(0, steering ? messageSeq : opening.seq)
      if (steering) seed.push(...interruptedTurnClosers(seed))
    } else {
      if (receipt?.revision.admission === undefined) throw new Error('This session has no admitted prompt revision to retry.')
      const latestUser = source.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
      if (latestUser?.type === 'user/message' && latestUser.seq >= (source.header.seedLength ?? 0)
        && latestUser.data.id !== receipt.revision.admission.messageId) {
        throw new Error('A later user prompt has already continued this revision.')
      }
      const tail = source.events.findLast(event => event.type === 'turn/end')
      const live = ctx.agents.get(source.id)
      if (live?.status === 'running' || (tail?.type === 'turn/end' && tail.seq >= (source.header.seedLength ?? 0)
        && tail.data.reason.kind !== 'error' && tail.data.reason.kind !== 'aborted'
        && tail.data.reason.kind !== 'interrupted' && tail.data.reason.kind !== 'blocked')) {
        throw new Error('Only a failed or interrupted revision can be retried.')
      }
      message = receipt.revision.admission.message
      await deps.validateModel(source, message.content.some(block => block.type === 'image'))
      await Promise.all(message.content.flatMap(block => block.type === 'image' ? [ctx.attachments.readImage(block.attachment)] : []))
      turn = receipt.revision.turn
      seed = source.events.slice(0, receipt.seq)
    }

    const sourceAgent = ctx.agents.get(source.id)
    if (sourceAgent !== undefined) {
      sourceAgent.cancel({ kind: 'user' })
      await sourceAgent.whenIdle()
    }
    const composition = await deps.compose(source)
    const requestHeader = source.events.findLast(event => event.type === 'request/header')
    if (requestHeader !== undefined && seed.findLast(event => event.type === 'request/header') !== requestHeader) {
      seed.push({ ...requestHeader, seq: seed.length })
    }
    const retry = input.edit === undefined ? previous : undefined
    const revision: ConversationRevision = {
      sessionId: childId,
      conversationId: previous?.conversationId ?? source.id,
      previousSessionId: retry?.previousSessionId ?? previous?.revisionId ?? source.id,
      turn,
      createdAt: retry?.createdAt ?? Date.now(),
      revisionId: retry === undefined ? childId : retry.revisionId ?? source.id,
      attempt: retry === undefined ? 1 : (retry.attempt ?? 1) + 1,
      admission: { fingerprint, messageId: message.id, message },
    }
    seed.push({ type: 'session/revision', data: revision, seq: seed.length, time: Date.now(), ignorable: true })
    const title = source.events.findLast(event => event.type === 'session/title')
    if (title !== undefined && !seed.includes(title)) seed.push({ ...title, seq: seed.length })
    const handle = await ctx.agents.create({
      sessionId: childId, seed,
      meta: {
        ...source.header.cwd === undefined ? {} : { cwd: source.header.cwd },
        parentSession: source.id, seedLength: seed.length,
        ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
      },
      agentOptions: composition.agentOptions,
      ...composition.setup === undefined ? {} : { setup: composition.setup },
    })
    deps.retain(handle)
    await start(handle.agent, message, workspace)
    return { sessionId: childId, revision }
  }

  async function start(agent: Agent, message: RevisionMessage, workspace: Workspace | undefined): Promise<void> {
    const attempted = agent.session.events.some(event => event.type === 'turn/start'
      && event.seq >= (agent.session.header.seedLength ?? 0))
    if (attempted) return
    if (!agent.inbox.nextTurn.some(item => item.id === message.id)) agent.send(message, 'next-turn', false)
    await ctx.sessions.flush(agent.session)
    await workspace?.attachSession(agent.id)
    // No await between taking the parked item and waking its sole driver.
    agent.inbox.remove(message.id)
    agent.followup(message)
  }

  return (input) => {
    const childId = `session-edit-${digest([input.sessionId, input.idempotencyKey])}` as SessionId
    const fingerprint = digest([input.sessionId, input.workspaceId, input.edit ?? null])
    const inflight = pending.get(childId)
    if (inflight !== undefined) return inflight.fingerprint === fingerprint
      ? inflight.promise : Promise.reject(new Error('This idempotency key has already been used for a different edit.'))
    const promise = admit(input, childId, fingerprint).finally(() => { pending.delete(childId) })
    pending.set(childId, { fingerprint, promise })
    return promise
  }
}
