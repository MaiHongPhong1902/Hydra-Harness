import { describe, expect, it, vi } from 'vitest'
import { CallId, createToolResultMessage, createUserMessage, type Message } from '@hydraharness/harness-llm'
import { Session, SessionId } from '@hydraharness/harness-session'
import { PageMemoryContext } from '../src/context.ts'

function session() { return Session.create(SessionId('context-test')) }

function automatic(subject: Session, text: string) {
  return subject.append('user/message', createUserMessage({
    source: { kind: 'plugin', plugin: 'page-memory' }, content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
}

function explicit(subject: Session, text: string, turn = 1, name = 'page_memory_get', isError = false) {
  const callId = CallId(`call-${subject.seq}`)
  const call = subject.append('tool/call', { callId, turn, step: 1, name, arguments: '{}' })
  return subject.append('tool/result', { turn, step: 1, message: createToolResultMessage({
    callId, isError, content: [{ type: 'text', text }],
  }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

// Authoritative pre-index lookup remains the oracle for event delivery and positional rewrites.
function scan(subject: Session, explicitTurn?: number) {
  for (const seq of [...subject.surface.nodes].reverse()) {
    const event = subject.events[seq]!
    if (event.type === 'user/message' && explicitTurn === undefined && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'page-memory') {
      return { text: event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), message: event.data }
    }
    if (event.type !== 'tool/result' || (explicitTurn !== undefined && event.data.turn !== explicitTurn)) continue
    const result = event.data.message.content[0]
    if (result.isError || !event.sourceEventSeqs?.some((seq) => {
      const call = subject.events[seq]
      return call?.type === 'tool/call' && call.data.name === 'page_memory_get' && call.data.callId === result.toolCallId
    })) continue
    return { text: result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), message: event.data.message }
  }
}

function parity(subject: Session, projection: PageMemoryContext) {
  const turn = [...subject.events].reverse().find(event => event.type === 'turn/start')?.data.turn ?? 0
  expect(projection.turn).toBe(turn)
  expect(projection.latest()).toEqual(scan(subject))
  expect(projection.latest(turn)).toEqual(scan(subject, turn))
}

describe('page-memory context projection', () => {
  it('bootstraps retained guidance and current-turn explicit reads from a restored log', () => {
    const source = session()
    source.append('turn/start', { turn: 1 })
    const first = automatic(source, 'Initial guidance')
    explicit(source, 'Earlier approved read')
    source.append('turn/start', { turn: 2 })
    explicit(source, 'Failed read', 2, 'page_memory_get', true)
    explicit(source, 'Other tool', 2, 'echo')
    automatic(source, 'Current guidance')
    const seed = JSON.parse(JSON.stringify(source.events)) as typeof source.events
    const restored = Session.fromRestore(source.id, seed, { ...source.header })
    const projection = new PageMemoryContext(restored)
    parity(restored, projection)
    expect(projection.latest(1)).toBeUndefined()
    expect(projection.contains(first.data)).toBe(false)
    expect(projection.contains(restored.events[first.seq]!.data as Message)).toBe(true)
  })

  it('follows live events without copying the log on repeated reads or ordinary tool results', () => {
    const subject = session()
    subject.append('turn/start', { turn: 1 })
    const projection = new PageMemoryContext(subject)
    parity(subject, projection)
    const events = vi.spyOn(subject, 'events', 'get')
    const message = automatic(subject, 'Live guidance')
    projection.accept(message)
    const callId = CallId('observed-call')
    projection.accept(subject.append('tool/call', { turn: 1, step: 1, callId, name: 'browser_snapshot', arguments: '{}' }))
    projection.accept(subject.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
      content: [{ type: 'text', text: 'Live page' }] }) }, { surfaceOp: 'append', sourceEventSeqs: [message.seq + 1] }))
    projection.accept(subject.append('step/end', { turn: 1, step: 1 }))
    for (let index = 0; index < 1000; index++) {
      projection.accept(subject.append('step/start', { turn: 1, step: index + 2 }))
      expect(projection.turn).toBe(1)
      expect(projection.latest()?.message).toBe(message.data)
      expect(projection.contains(message.data)).toBe(true)
    }
    expect(events).not.toHaveBeenCalled()
    events.mockRestore()
    parity(subject, projection)
  })

  it('catches missed and out-of-order notifications up before returning guidance', () => {
    const subject = session()
    const projection = new PageMemoryContext(subject)
    expect(projection.latest()).toBeUndefined()
    subject.append('turn/start', { turn: 1 })
    const message = automatic(subject, 'Missed guidance')
    projection.accept(message)
    parity(subject, projection)
    projection.accept(message)
    expect(projection.latest()?.message).toBe(message.data)
    explicit(subject, 'Missed explicit read')
    parity(subject, projection)
  })

  it('uses exact call provenance and ignores unsuccessful or unrelated results', () => {
    const subject = session()
    const projection = new PageMemoryContext(subject)
    expect(projection.turn).toBe(0)
    projection.accept(subject.append('turn/start', { turn: 1 }))
    const callId = CallId('read')
    const call = subject.append('tool/call', { turn: 1, step: 1, callId, name: 'page_memory_get', arguments: '{}' })
    projection.accept(call)
    const mismatch = subject.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: CallId('wrong-id'), isError: false, content: [{ type: 'text', text: 'Wrong call' }],
    }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    projection.accept(mismatch)
    const unproven = subject.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: CallId('no-provenance'), isError: false, content: [{ type: 'text', text: 'Unproven' }],
    }) }, { surfaceOp: 'append' })
    projection.accept(unproven)
    expect(projection.latest()).toBeUndefined()
    const approved = subject.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId, isError: false, content: [{ type: 'text', text: 'Approved' }],
    }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    projection.accept(approved)
    parity(subject, projection)
    expect(projection.contains(mismatch.data.message)).toBe(false)
    expect(projection.contains(unproven.data.message)).toBe(false)
    expect(projection.contains(approved.data.message)).toBe(true)
    const failed = explicit(subject, 'Failure', 1, 'page_memory_get', true)
    parity(subject, projection)
    expect(projection.contains(failed.data.message)).toBe(false)
  })

  it('preserves old-turn guidance while resetting current-turn explicit fallback', () => {
    const subject = session()
    subject.append('turn/start', { turn: 1 })
    const projection = new PageMemoryContext(subject)
    explicit(subject, 'First approved read')
    parity(subject, projection)
    projection.accept(subject.append('turn/start', { turn: 1 }))
    parity(subject, projection)
    projection.accept(subject.append('turn/start', { turn: 2 }))
    expect(projection.latest()?.text).toBe('First approved read')
    expect(projection.latest(2)).toBeUndefined()
    parity(subject, projection)
    explicit(subject, 'Late older-turn read', 1)
    parity(subject, projection)
    explicit(subject, 'Current approved read', 2)
    parity(subject, projection)
    projection.accept(automatic(subject, 'Automatic update'))
    parity(subject, projection)
    expect(projection.latest(2)?.text).toBe('Current approved read')
  })

  it('rebuilds positional replacements without confusing log order or cited retained nodes', () => {
    const subject = session()
    subject.append('turn/start', { turn: 1 })
    const first = automatic(subject, 'First guidance')
    const later = explicit(subject, 'Later guidance')
    const projection = new PageMemoryContext(subject)
    parity(subject, projection)
    const replacement = subject.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'page-memory' },
      content: [{ type: 'text', text: 'Rewritten first guidance' }] }),
    { surfaceOp: { op: 'replace', start: first.seq, end: first.seq }, sourceEventSeqs: [first.seq, later.seq] })
    projection.accept(replacement)
    parity(subject, projection)
    expect(projection.latest()?.message).toBe(later.data.message)
    expect(projection.contains(first.data)).toBe(false)
    expect(projection.contains(later.data.message)).toBe(true)
    const nodes = [...subject.surface.nodes]
    projection.accept(subject.append('user/message', createUserMessage({ source: { kind: 'plugin', plugin: 'compaction' },
      content: [{ type: 'text', text: 'Summary' }] }),
    { surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes.at(-1)! }, sourceEventSeqs: nodes }))
    parity(subject, projection)
    expect(projection.contains(later.data.message)).toBe(false)
    expect(projection.latest()).toBeUndefined()
    projection.accept(automatic(subject, 'Recalled after compaction'))
    parity(subject, projection)
  })

  it('validates rewritten results against the cited call rather than the removed pending batch', () => {
    const subject = session()
    subject.append('turn/start', { turn: 1 })
    const original = explicit(subject, 'Full guidance')
    const projection = new PageMemoryContext(subject)
    parity(subject, projection)
    const replacement = subject.append('tool/result', { ...original.data, message: { ...original.data.message,
      content: [{ ...original.data.message.content[0], content: [{ type: 'text', text: 'Short guidance' }] }],
    } }, { surfaceOp: { op: 'replace', start: original.seq, end: original.seq }, sourceEventSeqs: [...original.sourceEventSeqs!, original.seq] })
    projection.accept(replacement)
    parity(subject, projection)
    expect(projection.contains(original.data.message)).toBe(false)
    expect(projection.latest()?.text).toBe('Short guidance')
  })
})
