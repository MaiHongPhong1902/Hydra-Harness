/** Diagnostic model-call records; none contribute to conversation history. */

import type { CallId, FinishReason, GenerateOptions, ReasoningEffortId, TokenUsage } from '@hydraharness/harness-llm'

/** One consumed LLM stream, before adapter work begins. */
export interface LlmCallStart {
  provider: string
  model: string
  /** Conversation requests are marked by the loop; unclassified one-shots remain auxiliary. */
  purpose: NonNullable<GenerateOptions['purpose']> | 'conversation' | 'auxiliary'
  /** Present only for a loop request inside an entered step. */
  turn?: number
  step?: number
  reasoningEffort?: ReasoningEffortId
  maxTokens?: number
  messageCount: number
  systemChars: number
  /** Advertised tools, distinct from tool calls in the end record. */
  tools: string[]
}

/** The first non-empty text, reasoning, or tool-call delta of one stream. */
export interface LlmCallFirstOutput {
  /** Sequence of the matching llm/call-start in this session. */
  callSeq: number
  provider: string
  model: string
  kind: 'text' | 'reasoning' | 'tool-call'
  elapsedMs: number
}

/** Settled model stream, including failures and consumer cancellation. */
export interface LlmCallEnd {
  /** Sequence of the matching llm/call-start in this session. */
  callSeq: number
  provider: string
  model: string
  outcome: FinishReason['kind'] | 'closed' | 'exception'
  /** Monotonic elapsed time from stream consumption, including adapter setup. */
  elapsedMs: number
  firstOutputMs?: number
  firstTextMs?: number
  usage?: TokenUsage
  /** Complete calls requested by the model; execution results remain in tool/result. */
  toolCalls: { callId: CallId; name: string }[]
  /** Safe error classification only; provider bodies and credentials are not copied. */
  errorCode?: string
}

declare module '@hydraharness/harness-session/types' {
  interface SessionEventMap {
    /** Diagnostic start of a session-associated model stream. */
    'llm/call-start': LlmCallStart
    /** First meaningful output observed from that stream. */
    'llm/call-first-output': LlmCallFirstOutput
    /** Model stream outcome, timing, usage, and requested tool identities. */
    'llm/call-end': LlmCallEnd
  }
}
