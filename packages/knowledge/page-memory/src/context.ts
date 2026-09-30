/**
 * Session-local page guidance derived from committed events and the active context.
 * @module @hydraharness/harness-page-memory/context
 */
import type { CallId, Message } from '@hydraharness/harness-llm'
import type { Session, SessionEvent } from '@hydraharness/harness-session'
import { isSurfaceEvent } from '@hydraharness/harness-session'

/** Logged page guidance and the exact message whose presence authorizes reuse. */
export interface Guidance {
  text: string
  message: Message
}

function guidanceOf(event: SessionEvent, memoryRead: boolean): Guidance | undefined {
  if (event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'page-memory') {
    return { text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), message: event.data }
  }
  if (event.type !== 'tool/result' || !memoryRead || event.data.message.content[0].isError) return
  const result = event.data.message.content[0]
  return { text: result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), message: event.data.message }
}

/** Incremental guidance visibility; replacements rebuild from the authoritative context. */
export class PageMemoryContext {
  private cursor = 0
  private currentTurn = 0
  private generation = -1
  private dirty = true
  private latestValue: Guidance | undefined
  private explicitValue: Guidance | undefined
  private readonly retained = new Set<Message>()
  private readonly pendingCalls = new Map<number, { name: string; callId: CallId }>()

  /**
   * Bind to one Session object, including sessions seeded without event notifications.
   * @param session - authoritative log and active context.
   */
  constructor(private readonly session: Session) {}

  /**
   * Synchronize the current turn with committed session events.
   * @returns the latest turn number, or zero before the first turn.
   */
  get turn(): number {
    this.synchronize()
    return this.currentTurn
  }

  /**
   * Follow one post-commit event; gaps are caught up synchronously on the next read.
   * @param event - committed event from this Session's event feed.
   */
  accept(event: SessionEvent): void {
    if (event.seq !== this.cursor) return
    this.cursor++
    let memoryRead = false
    switch (event.type) {
      case 'turn/start':
        if (this.currentTurn !== event.data.turn) this.explicitValue = undefined
        this.currentTurn = event.data.turn
        break
      case 'tool/call':
        this.pendingCalls.set(event.seq, { name: event.data.name, callId: event.data.callId })
        break
      case 'tool/result': {
        const result = event.data.message.content[0]
        memoryRead = event.sourceEventSeqs?.some((seq) => {
          const call = this.pendingCalls.get(seq)
          return call?.name === 'page_memory_get' && call.callId === result.toolCallId
        }) === true
        // Rewritten or resumed results can cite calls outside the pending batch.
        if (!result.isError && !memoryRead && event.sourceEventSeqs?.some(seq => !this.pendingCalls.has(seq)) === true) this.dirty = true
        for (const [seq, pending] of this.pendingCalls) {
          if (pending.callId === result.toolCallId) this.pendingCalls.delete(seq)
        }
        break
      }
      case 'step/end':
        this.pendingCalls.clear()
        break
      default:
        // SessionEventMap is merge-extensible; other events do not change page guidance.
        break
    }
    if (!isSurfaceEvent(event)) return
    if (event.surfaceOp !== 'append') { this.dirty = true; return }
    this.retain(event, guidanceOf(event, memoryRead))
  }

  /**
   * Read the latest retained guidance, optionally limited to explicit reads in this turn.
   * @param explicitTurn - current turn required by the approval fallback; omission includes automatic recall.
   * @returns matching active guidance, or undefined when none is retained.
   */
  latest(explicitTurn?: number): Guidance | undefined {
    this.synchronize()
    return explicitTurn === undefined ? this.latestValue : explicitTurn === this.currentTurn ? this.explicitValue : undefined
  }

  /**
   * Check the exact logged message after synchronizing replacements and missed events.
   * @param message - guidance included in an actual agent-loop model request.
   * @returns whether that same message remains in the active context.
   */
  contains(message: Message): boolean {
    this.synchronize()
    return this.retained.has(message)
  }

  private retain(event: SessionEvent, guidance: Guidance | undefined): void {
    if (guidance === undefined) return
    this.retained.add(guidance.message)
    this.latestValue = guidance
    if (event.type === 'tool/result' && event.data.turn === this.currentTurn) this.explicitValue = guidance
  }

  private synchronize(): void {
    if (this.cursor < this.session.seq) {
      const events = this.session.events
      for (let seq = this.cursor; seq < events.length; seq++) {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- Session sequences are contiguous.
        this.accept(events[seq]!)
      }
    }
    const generation = this.session.surface.replaceGeneration
    if (!this.dirty && this.generation === generation) return
    const events = this.session.events
    this.retained.clear()
    this.latestValue = undefined
    this.explicitValue = undefined
    for (const seq of this.session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- Surface nodes reference accepted Session events.
      const event = events[seq]!
      const memoryRead = event.type === 'tool/result' && event.sourceEventSeqs?.some((source) => {
        const call = events[source]
        return call?.type === 'tool/call' && call.data.name === 'page_memory_get' && call.data.callId === event.data.message.content[0].toolCallId
      }) === true
      this.retain(event, guidanceOf(event, memoryRead))
    }
    this.generation = generation
    this.dirty = false
  }
}
