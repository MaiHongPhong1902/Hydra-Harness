import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@hydraharness/harness-llm'
import { Session, SessionId, SessionVersionId, ORIGINAL_SESSION_VERSION, foldSurface, sessionVersions, sessionVersionReference } from '../src/index.ts'

describe('session-local transcript paths', () => {
  it('shares prefix events, restores complete paths, and invalidates derived context', () => {
    const session = Session.create(SessionId('one'))
    session.append('request/header', { header: { config: { provider: 'fixture', model: 'first' } }, reason: 'initial' })
    const prefix = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'shared prefix' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const anchor = session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'old question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const original = session.events
    const originalMessages = session.deriveMessages()
    const version = SessionVersionId('edited')
    session.append('session/version', { versionId: version, parentVersionId: ORIGINAL_SESSION_VERSION, beforeSeq: anchor.seq })
    session.append('request/header', { header: { config: { provider: 'fixture', model: 'second' } }, reason: 'initial' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new question' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    expect(session.activeEvents.find(event => event.seq === prefix.seq)).toBe(prefix)
    expect(session.deriveMessages().map(message => message.content)).toEqual([
      [{ type: 'text', text: 'shared prefix' }], [{ type: 'text', text: 'new question' }],
    ])
    expect(session.events.slice(0, original.length)).toEqual(original)
    expect(session.requestHeader()?.config.model).toBe('second')
    session.append('session/version-selected', { versionId: ORIGINAL_SESSION_VERSION })
    expect(session.deriveMessages()).toEqual(originalMessages)
    expect(session.requestHeader()?.config.model).toBe('first')
    const restored = Session.create(session.id, session.events, session.header)
    expect(restored.deriveMessages()).toEqual(originalMessages)
    expect(foldSurface(session.events).nodes).toEqual(session.surface.nodes)
    expect(sessionVersions(session.events).events(version).find(event => event.seq === prefix.seq)).toBe(prefix)
    session.append('session/version-selected', { versionId: version })
    expect(session.requestHeader()?.config.model).toBe('second')
    expect(JSON.stringify(session.deriveMessages())).not.toContain('old question')
  })

  it('rejects missing paths, repeated identifiers and references outside the parent before acceptance', () => {
    const session = Session.create(SessionId('invalid'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const version = SessionVersionId('empty')
    session.append('session/version', { versionId: version, parentVersionId: ORIGINAL_SESSION_VERSION, beforeSeq: 0 })
    const before = session.events
    expect(() => session.append('session/version-selected', { versionId: SessionVersionId('missing') })).toThrow('does not exist')
    expect(() => session.append('session/version', { versionId: version, parentVersionId: ORIGINAL_SESSION_VERSION, beforeSeq: 0 })).toThrow('must be new')
    expect(() => session.append('session/version', { versionId: SessionVersionId('new'), parentVersionId: version, beforeSeq: 1 })).toThrow('outside its parent')
    expect(() => session.append('session/version', { versionId: SessionVersionId('new'), parentVersionId: SessionVersionId('missing'), beforeSeq: 0 })).toThrow('parent does not exist')
    expect(() => session.append('session/version', { versionId: SessionVersionId('new'), parentVersionId: version, beforeSeq: -1 })).toThrow('must precede')
    expect(() => sessionVersions([{ type: 'turn/start', seq: 2, time: 0, data: { turn: 1 } }])).toThrow('not contiguous')
    expect(session.events).toBe(before)
  })
})

it('pages references within UTF-8 limits without splitting emoji or selecting a version', () => {
  const session = Session.create(SessionId('reference'))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '🐉Tiếng Việt'.repeat(80) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  let offset = 0
  let pages = 0
  for (;;) {
    const page = sessionVersionReference(session.activeEvents, ORIGINAL_SESSION_VERSION, 256, offset)
    expect(new TextEncoder().encode(page.text).byteLength).toBeLessThanOrEqual(256)
    expect(page.text).not.toContain('�')
    pages++
    if (page.nextOffset === null) break
    expect(page.nextOffset).toBeGreaterThan(offset)
    offset = page.nextOffset
  }
  expect(pages).toBeGreaterThan(1)
  expect(() => sessionVersionReference(session.activeEvents, ORIGINAL_SESSION_VERSION, 1)).toThrow('too small')
  expect(() => sessionVersionReference(session.activeEvents, ORIGINAL_SESSION_VERSION, 256, -1)).toThrow('offset')
  const complete = sessionVersionReference(session.activeEvents, ORIGINAL_SESSION_VERSION, 4096)
  const body = complete.text.split('\n')[2]
  if (body === undefined) throw new Error('Reference page has no transcript line')
  expect(() => sessionVersionReference(session.activeEvents, ORIGINAL_SESSION_VERSION, 256, body.indexOf('🐉') + 1))
    .toThrow('Unicode code point')
  session.append('assistant/message', { turn: 1, step: 1,
    message: createAssistantMessage({ content: [], source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  expect(sessionVersionReference(session.activeEvents, ORIGINAL_SESSION_VERSION, 4096).text).toBe(complete.text)
})
