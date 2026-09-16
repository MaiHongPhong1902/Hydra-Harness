/** Session-local diagnostics around the shared LLM stream waterfall. */

import type { Context } from '@hydra/cordis'
import { isAgentLoopRequest, isTokenDelta } from '@hydra/harness-llm'
import type { GenerateOptions, StreamChunk } from '@hydra/harness-llm'
import type { LlmCallEnd } from './types.ts'
import type {} from '@hydra/harness-session'

export type { LlmCallStart, LlmCallFirstOutput, LlmCallEnd } from './types.ts'

/** Cordis plugin identity. */
export const name = 'llm-call-log'
/** Services owning stream dispatch and the canonical session log. */
export const inject = ['llm', 'sessions']

async function* observe(
  ctx: Context,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
  if (session === undefined) {
    yield* next()
    return
  }
  const conversation = isAgentLoopRequest(options)
  const step = conversation ? session.events.findLast(event => event.type === 'step/start') : undefined
  const route = { provider: options.provider, model: options.model }
  const started = performance.now()
  const start = session.append('llm/call-start', {
    ...route,
    purpose: options.purpose ?? (conversation ? 'conversation' : 'auxiliary'),
    ...(step === undefined ? {} : { turn: step.data.turn, step: step.data.step }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    messageCount: options.messages.length,
    systemChars: options.system?.length ?? 0,
    tools: options.tools?.map(tool => tool.name) ?? [],
  })
  const result: LlmCallEnd = {
    ...route, callSeq: start.seq, outcome: 'closed', elapsedMs: 0, toolCalls: [],
  }
  const elapsed = (): number => Math.max(0, Math.round(performance.now() - started))
  let finished = false
  try {
    for await (const chunk of next()) {
      if (isTokenDelta(chunk) && result.firstOutputMs === undefined) {
        result.firstOutputMs = elapsed()
        if (ctx.sessions.get(session.id) === session) {
          session.append('llm/call-first-output', {
            ...route,
            callSeq: start.seq,
            kind: chunk.type === 'text-delta' ? 'text' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call',
            elapsedMs: result.firstOutputMs,
          })
        }
      }
      if (chunk.type === 'text-delta' && chunk.text.length > 0) result.firstTextMs ??= elapsed()
      if (chunk.type === 'usage') result.usage = chunk.usage
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        result.toolCalls.push({ callId: chunk.block.id, name: chunk.block.name })
      }
      if (chunk.type === 'finish') {
        finished = true
        result.outcome = chunk.reason.kind
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') result.errorCode = chunk.reason.failure.code
        result.elapsedMs = elapsed()
      }
      yield chunk
    }
  } catch (error: unknown) {
    result.outcome = options.signal?.aborted ? 'aborted' : 'exception'
    throw error
  } finally {
    if (!finished) {
      result.elapsedMs = elapsed()
      if (options.signal?.aborted) result.outcome = 'aborted'
    }
    if (ctx.sessions.get(session.id) === session) session.append('llm/call-end', result)
  }
}

/**
 * Record each consumed session-associated stream without changing its chunks.
 * @param ctx - composing fiber; disposal removes the listener while existing streams settle normally.
 */
export function apply(ctx: Context): void {
  ctx.on('llm/stream', (options, next) => observe(ctx, options, next))
}
