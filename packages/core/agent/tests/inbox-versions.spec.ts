import { expect, it } from 'vitest'
import { Inbox } from '../src/inbox.ts'
import { Session, SessionId, SessionVersionId, ORIGINAL_SESSION_VERSION } from '@hydraharness/harness-session'
import { createUserMessage } from '@hydraharness/harness-llm'

it('restores pending messages from one selected transcript and never from an inactive version', () => {
  const session = Session.create(SessionId('inbox-versions'))
  const notifications = { inserted() {}, discarded() {}, claimed() {} }
  const inbox = new Inbox(session, notifications)
  const old = createUserMessage({ content: [{ type: 'text', text: 'original pending' }], source: { kind: 'user' } })
  inbox.append('next-turn', old)
  const branch = SessionVersionId('new')
  session.append('session/version', { versionId: branch, parentVersionId: ORIGINAL_SESSION_VERSION, beforeSeq: 0 })
  expect(inbox.hasPending).toBe(false)
  const current = createUserMessage({ content: [{ type: 'text', text: 'new pending' }], source: { kind: 'user' } })
  inbox.append('next-step', current)
  session.append('session/version-selected', { versionId: ORIGINAL_SESSION_VERSION })
  expect(inbox.nextTurn).toEqual([old])
  expect(inbox.nextStep).toEqual([])
  const restored = new Inbox(Session.create(session.id, session.events, session.header), notifications)
  expect(restored.nextTurn).toEqual([old])
  session.append('session/version-selected', { versionId: branch })
  expect(inbox.nextTurn).toEqual([])
  expect(inbox.nextStep).toEqual([current])
})
