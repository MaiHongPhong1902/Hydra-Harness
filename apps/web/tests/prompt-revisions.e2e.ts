/** Edit acceptance through the shipped Web composition, real log, RPC, and browser. */
import { randomUUID } from 'node:crypto'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import { createAssistantMessage, createUserMessage, LlmAdapter, resolveRetryPolicy } from '@hydra/harness-llm'
import type { GenerateOptions, StreamChunk } from '@hydra/harness-llm'
import SessionStore, { SessionId, interruptedTurnClosers } from '@hydra/harness-session'
import SqliteSessionPersistence from '@hydra/harness-session-persistence-sqlite'
import type { Session } from '@hydra/harness-session'
import { RpcId } from '@hydra/harness-host-apiproxy'
import type { PromptRevisionRequest, RevisionMessage, RpcResponse } from '@hydra/harness-host-apiproxy'
import { sessionReviseRequestSchema } from '../../../packages/host/apiproxy/src/api/sessions.schema.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const golden = fileURLToPath(new URL('./snapshots/prompt-revisions/active.expected.md', import.meta.url))
const request = <P>(payload: P) => ({ rpcId: RpcId(randomUUID()), payload })
function value<T>(response: RpcResponse<T>): T {
  if (!response.result.ok) throw new Error(response.result.error.message)
  return response.result.value
}

class RevisionAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  mode: 'normal' | 'fail' | 'hang' = 'normal'
  stopped = 0
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test') }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'edit-test', name: 'Edit test', inputModalities: ['text', 'image'] as const }]) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const mode = this.mode
    this.mode = 'normal'
    if (mode === 'fail') throw new Error('Deliberate generation failure')
    yield { type: 'text-delta', index: 0, text: 'Hello from the active revision.' }
    if (mode === 'hang') {
      const signal = options.signal!
      if (!signal.aborted) await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      this.stopped++
      signal.throwIfAborted()
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('prompt revisions: immutable conversation paths', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const adapter = new RevisionAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['revision-test'], adapter))
    browser = await chromium.launch({ headless: true })
    page = await newEnglishPage(browser)
  })
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  async function source(name: string, turns = 2, firstContent?: RevisionMessage['content']): Promise<Session> {
    const id = value(await scaffold.ctx.apiProxy.sessions.create(request({ cwd: scaffold.workspaceCwd }))).sessionId
    const session = scaffold.ctx.agents.get(id)!.session
    session.append('request/header', { header: { config: { provider: 'revision-test', model: 'edit-test' } }, reason: 'initial' })
    for (let turn = 1; turn <= turns; turn++) {
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: turn === 1 && firstContent !== undefined ? firstContent : [{ type: 'text',
          text: turn === 1 ? 'My name is Alice.' : turn === 2 ? 'What is my name?' : `Old prompt ${turn}` }],
      }), { surfaceOp: 'append' })
      session.append('assistant/message', { turn, step: 1, message: createAssistantMessage({
        content: [{ type: 'text', text: turn === 1 ? 'Nice to meet you, Alice.' : turn === 2 ? 'Alice.' : `Old answer ${turn}` }],
        source: { provider: 'revision-test', model: 'edit-test' },
      }) }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    value(await scaffold.ctx.apiProxy.sessions.rename(request({ sessionId: id, title: name })))
    await scaffold.ctx.sessions.flush(session)
    return session
  }

  function input(session: Session, text: string, index = 0): PromptRevisionRequest {
    return {
      sessionId: session.id,
      workspaceId: scaffold.ctx.workspaceRegistry.list().find(w => w.sessionIds.includes(session.id))?.id ?? null,
      idempotencyKey: randomUUID(),
      edit: { messageSeq: session.events.filter(event => event.type === 'user/message')[index]!.seq, text },
    }
  }
  async function revise(payload: PromptRevisionRequest) {
    const receipt = value(await scaffold.ctx.apiProxy.sessions.revise(request(payload)))
    const agent = scaffold.ctx.agents.get(receipt.sessionId)!
    await agent.whenIdle()
    await scaffold.ctx.sessions.flush(agent.session)
    return { ...receipt, session: agent.session }
  }
  async function open(title: string) {
    await page.goto(scaffold.baseUrl)
    await page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor()
    const group = page.getByRole('treeitem').first()
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
    await page.getByText(title, { exact: true }).first().click()
  }

  it('EDIT-008–018: preserves history, excludes downstream context, deduplicates and retries failed generation', async () => {
    const original = await source('Host revision checks')
    const before = [...original.events]
    const edit = input(original, '  Tôi tên Bob.\nGiữ Unicode 🐉  ', 1)
    const responses = await Promise.all([
      scaffold.ctx.apiProxy.sessions.revise(request(edit)), scaffold.ctx.apiProxy.sessions.revise(request(edit)),
    ])
    expect(value(responses[0]).sessionId).toBe(value(responses[1]).sessionId)
    const first = await revise(edit)
    expect(adapter.requests).toHaveLength(1)
    expect(original.events).toEqual(before)
    const context = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(context).toContain('My name is Alice.')
    expect(context).toContain('Nice to meet you, Alice.')
    expect(context).not.toContain('What is my name?')
    expect(context).not.toContain('"text":"Alice."')
    expect(first.session.deriveMessages().filter(message => message.source.kind === 'user').at(-1)!.content)
      .toEqual([{ type: 'text', text: edit.edit!.text }])
    expect(value(await scaffold.ctx.apiProxy.sessions.revise(request(edit))).sessionId).toBe(first.sessionId)
    expect(adapter.requests).toHaveLength(1)
    expect((await scaffold.ctx.apiProxy.sessions.revise(request({ ...edit, edit: { ...edit.edit!, text: 'different' } }))).result.ok).toBe(false)

    adapter.mode = 'fail'
    const failed = await revise(input(first.session, 'My name is Charlie.', 1))
    expect(failed.session.events.at(-1)?.data).toMatchObject({ reason: { kind: 'error' } })
    const retried = await revise({ sessionId: failed.sessionId, workspaceId: edit.workspaceId, idempotencyKey: randomUUID() })
    expect(retried.revision.revisionId).toBe(failed.revision.revisionId)
    expect(retried.revision.admission!.messageId).toBe(failed.revision.admission!.messageId)
    expect(retried.revision.attempt).toBe(2)
    expect(retried.session.deriveMessages().filter(message => message.source.kind === 'user')).toHaveLength(2)
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('Deliberate generation failure')
  })

  it('EDIT-020–024: validates empty input, source relationships, and retained attachments before creating a revision', async () => {
    const original = await source('Validation checks')
    const payload = input(original, 'valid')
    const before = scaffold.ctx.sessions.list().length
    for (const invalid of [
      { ...payload, edit: { ...payload.edit!, text: '' } },
      { ...payload, edit: { ...payload.edit!, text: ' \n\t ' } },
      { ...payload, sessionId: SessionId('forged') },
      { ...payload, edit: { ...payload.edit!, messageSeq: 99999 } },
      { ...payload, edit: { ...payload.edit!, messageSeq: 4 } },
      { ...payload, workspaceId: 'foreign-workspace' as typeof payload.workspaceId },
    ]) expect((await scaffold.ctx.apiProxy.sessions.revise(request(invalid))).result.ok).toBe(false)
    expect(scaffold.ctx.sessions.list()).toHaveLength(before)
    expect(sessionReviseRequestSchema.safeParse({ ...payload, parentId: 'forged' }).success).toBe(false)
    expect(sessionReviseRequestSchema.safeParse({ ...payload, revisionGroupId: 'forged' }).success).toBe(false)
  })

  it('EDIT-019/023: waits for the old stream to exit and preserves the cancelled new branch', async () => {
    const original = await source('Cancellation checks')
    adapter.mode = 'hang'
    const first = value(await scaffold.ctx.apiProxy.sessions.revise(request(input(original, 'Streaming Bob'))))
    await vi.waitFor(() => {
      expect(scaffold.ctx.agents.get(first.sessionId)!.session.events.some(event => event.type === 'assistant/chunk')).toBe(true)
    })
    const firstAgent = scaffold.ctx.agents.get(first.sessionId)!
    const stopped = adapter.stopped
    const second = await revise(input(firstAgent.session, 'Streaming Charlie'))
    expect(adapter.stopped).toBe(stopped + 1)
    expect(firstAgent.status).toBe('idle')
    expect(second.revision.conversationId).toBe(original.id)
    adapter.mode = 'hang'
    const third = value(await scaffold.ctx.apiProxy.sessions.revise(request(input(second.session, 'Stop this revision'))))
    const thirdAgent = scaffold.ctx.agents.get(third.sessionId)!
    await vi.waitFor(() => {
      expect(thirdAgent.session.events.some(event => event.type === 'assistant/chunk'
        && event.seq >= thirdAgent.session.header.seedLength!)).toBe(true)
    })
    const crashPrefix = [...thirdAgent.session.events]
    const repaired = [...crashPrefix, ...interruptedTurnClosers(crashPrefix)]
    expect(repaired.at(-1)?.data).toMatchObject({ reason: { kind: 'interrupted' } })
    value(await scaffold.ctx.apiProxy.sessions.cancel(request({ sessionId: third.sessionId })))
    await thirdAgent.whenIdle()
    expect(thirdAgent.session.events.at(-1)?.data).toMatchObject({ reason: { kind: 'aborted' } })
    expect(thirdAgent.session.deriveMessages().some(message => message.id === third.revision.admission!.messageId)).toBe(true)
  })

  it('EDIT-022: allows only text edits, preserves attachments, and rejects missing images before publication', async () => {
    const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    const attachment = await scaffold.ctx.attachments.saveImage({ data, mediaType: 'image/png', name: 'financial.png' })
    const original = await source('Image edit', 1, [{ type: 'image', attachment }, { type: 'text', text: 'Read financial numbers' }])
    const save = vi.spyOn(scaffold.ctx.attachments, 'saveImages')
    try {
      await open('Image edit')
      const row = page.locator('[data-chat-flow-kind="user"]').first()
      await row.getByRole('button', { name: 'Edit', exact: true }).click()
      const form = page.getByRole('form', { name: 'Edit prompt' })
      expect(await form.locator('input[type="file"]').count()).toBe(0)
      expect(await form.getByRole('button').allTextContents()).toEqual(['Cancel', 'Save & resend'])
      expect(await row.locator('img').count()).toBe(1)
      await page.getByRole('textbox', { name: 'Edit prompt' }).fill('Updated financial question')
      const settled = scaffold.whenTurnSettled()
      await form.getByRole('button', { name: 'Save & resend' }).click()
      const selected = await settled
      await page.getByText('Updated financial question', { exact: true }).waitFor()
      expect(scaffold.ctx.sessions.get(selected)!.deriveMessages().find(message => message.source.kind === 'user')?.content)
        .toEqual([{ type: 'image', attachment }, { type: 'text', text: 'Updated financial question' }])
      const beforeMutation = scaffold.ctx.sessions.list().length
      const payload = input(original, 'Forbidden attachment changes')
      for (const mutation of [
        { attachmentIds: [] },
        { attachmentIds: [attachment.attachmentId] },
        { attachmentIds: ['forged-image'] },
        { attachments: [] },
        { images: [{ type: 'image', mediaType: 'image/png', data: data.toString('base64') }] },
      ]) {
        const invalid = { ...payload, edit: { ...payload.edit!, ...mutation } }
        expect((await scaffold.ctx.apiProxy.sessions.revise(request(invalid))).result.ok).toBe(false)
        const response = await page.request.post(`${scaffold.baseUrl}/api/session.revise`, {
          data: { type: 'client-request', method: 'session.revise', ...request(invalid) },
        })
        const rejected: unknown = await response.json()
        expect(rejected).toMatchObject({ result: { ok: false, error: { code: 'bad-request', message: 'invalid payload for session.revise' } } })
      }
      expect(scaffold.ctx.sessions.list()).toHaveLength(beforeMutation)
      const edited = await revise(input(original, '  '))
      expect(edited.revision.admission!.message.content).toEqual([{ type: 'image', attachment }, { type: 'text', text: '  ' }])
      expect(save).not.toHaveBeenCalled()
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain(attachment.attachmentId)
      const before = scaffold.ctx.sessions.list().length
      const missing = vi.spyOn(scaffold.ctx.attachments, 'readImage').mockRejectedValueOnce(new Error('Attachment is missing or expired.'))
      try {
        const result = await scaffold.ctx.apiProxy.sessions.revise(request(input(original, 'Retry image')))
        expect(result.result).toMatchObject({ ok: false, error: { message: 'Attachment is missing or expired.' } })
        expect(scaffold.ctx.sessions.list()).toHaveLength(before)
      } finally { missing.mockRestore() }
    } finally { save.mockRestore() }
  })

  it('resumes one admitted prompt after the durability acknowledgement fails', async () => {
    const original = await source('Admission retry')
    const payload = input(original, 'Durable admitted prompt')
    const before = scaffold.ctx.sessions.list().length
    const requests = adapter.requests.length
    const flush = scaffold.ctx.sessions.flush.bind(scaffold.ctx.sessions)
    const failure = vi.spyOn(scaffold.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      await flush(session)
      throw new Error('Lost durability acknowledgement')
    })
    try {
      const response = await scaffold.ctx.apiProxy.sessions.revise(request(payload))
      expect(response.result).toMatchObject({ ok: false, error: { message: 'Lost durability acknowledgement' } })
      expect(adapter.requests).toHaveLength(requests)
      expect(scaffold.ctx.sessions.list()).toHaveLength(before + 1)
    } finally { failure.mockRestore() }
    const revised = await revise(payload)
    expect(scaffold.ctx.sessions.list()).toHaveLength(before + 1)
    expect(adapter.requests).toHaveLength(requests + 1)
    expect(revised.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(revised.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('starts a durable parked admission exactly once after a Host restart', async () => {
    const original = await source('Parked admission restart')
    const payload = input(original, 'Resume parked prompt')
    const requests = adapter.requests.length
    const flush = scaffold.ctx.sessions.flush.bind(scaffold.ctx.sessions)
    const failure = vi.spyOn(scaffold.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      await flush(session)
      throw new Error('Crash after durable admission')
    })
    try {
      expect((await scaffold.ctx.apiProxy.sessions.revise(request(payload))).result.ok).toBe(false)
    } finally { failure.mockRestore() }
    const restarted = await launchWebScaffold({})
    try {
      await cp(scaffold.persistenceRoot, restarted.persistenceRoot, { recursive: true })
      restarted.ctx.effect(() => restarted.ctx.llm.registerAdapter(['revision-test'], adapter))
      const receipt = value(await restarted.ctx.apiProxy.sessions.revise(request(payload)))
      const agent = restarted.ctx.agents.get(receipt.sessionId)!
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(requests + 1)
      expect(agent.session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
      expect(agent.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(value(await restarted.ctx.apiProxy.sessions.revise(request(payload))).sessionId).toBe(receipt.sessionId)
      expect(adapter.requests).toHaveLength(requests + 1)
    } finally { await restarted.close() }
  })

  it('EDIT-014/017–019: loads durable revisions in a fresh Host and repairs a crash during streaming', async () => {
    const original = await source('Cold persistence')
    const completedInput = input(original, 'Durable Bob')
    const completed = await revise(completedInput)
    adapter.mode = 'hang'
    const interruptedInput = input(completed.session, 'Interrupted Charlie')
    const interrupted = value(await scaffold.ctx.apiProxy.sessions.revise(request(interruptedInput)))
    const running = scaffold.ctx.agents.get(interrupted.sessionId)!
    await vi.waitFor(() => { expect(running.session.events.some(event => event.type === 'assistant/chunk')).toBe(true) })
    await scaffold.ctx.sessions.flush(running.session)
    const restarted = await launchWebScaffold({})
    try {
      await cp(scaffold.persistenceRoot, restarted.persistenceRoot, { recursive: true })
      running.cancel({ kind: 'user' })
      await running.whenIdle()
      restarted.ctx.effect(() => restarted.ctx.llm.registerAdapter(['revision-test'], adapter))
      expect(restarted.ctx.sessions.get(completed.sessionId)).toBeUndefined()
      const requests = adapter.requests.length
      expect(value(await restarted.ctx.apiProxy.sessions.revise(request(completedInput))).sessionId).toBe(completed.sessionId)
      expect(adapter.requests).toHaveLength(requests)
      const loaded = await restarted.ctx.sessionPersistence.load(interrupted.sessionId)
      expect(loaded.events.at(-1)?.data).toMatchObject({ reason: { kind: 'interrupted' } })
      expect(value(await restarted.ctx.apiProxy.sessions.revise(request(interruptedInput))).sessionId).toBe(interrupted.sessionId)
      expect(adapter.requests).toHaveLength(requests)
      const retry = value(await restarted.ctx.apiProxy.sessions.revise(request({
        sessionId: interrupted.sessionId, workspaceId: null, idempotencyKey: randomUUID(),
      })))
      await restarted.ctx.agents.get(retry.sessionId)!.whenIdle()
      expect(retry.revision.revisionId).toBe(interrupted.revision.revisionId)
      expect(retry.revision.admission!.messageId).toBe(interrupted.revision.admission!.messageId)
      expect(retry.revision.attempt).toBe(2)
      expect(adapter.requests).toHaveLength(requests + 1)
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('Durable Bob')
    } finally { running.cancel({ kind: 'user' }); await running.whenIdle(); await restarted.close() }
  })

  it('preserves ancestors when editing a human steering message inside an open turn', async () => {
    const original = await source('Steering edit', 0)
    original.append('turn/start', { turn: 1 })
    original.append('step/start', { turn: 1, step: 1 })
    for (const text of ['Opening prompt', 'Old steering', 'Downstream steering']) {
      original.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const edited = await revise(input(original, 'New steering', 1))
    expect(edited.revision.turn).toBe(2)
    const context = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(context).toContain('Opening prompt')
    expect(context).toContain('New steering')
    expect(context).not.toContain('Old steering')
    expect(context).not.toContain('Downstream steering')
    original.append('step/end', { turn: 1, step: 1 })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('round-trips original and revised logs through a closed and reopened SQLite database', async () => {
    const original = await source('SQLite revision persistence')
    const edited = await revise(input(original, 'SQLite Bob'))
    const path = join(scaffold.workspaceCwd, 'prompt-revisions.db')
    const writer = new Context()
    try {
      await writer.plugin(SessionStore)
      await writer.plugin(SqliteSessionPersistence, { path })
      for (const session of [original, edited.session]) {
        await writer.sessionPersistence.create(session.header)
        await writer.sessionPersistence.append(session.id, session.events)
      }
    } finally { await writer.fiber.dispose() }
    const reader = new Context()
    try {
      await reader.plugin(SessionStore)
      await reader.plugin(SqliteSessionPersistence, { path })
      expect((await reader.sessionPersistence.load(original.id)).events).toEqual(original.events)
      const loaded = await reader.sessionPersistence.load(edited.sessionId)
      expect(loaded.events).toEqual(edited.session.events)
      expect(loaded.events.findLast(event => event.type === 'session/revision')?.data).toEqual(edited.revision)
    } finally { await reader.fiber.dispose() }
  })

  it('EDIT-001–007/014/015: Alice → Bob → Charlie through the inline editor and reload', async () => {
    const original = await source('Edit acceptance')
    try {
      await open('Edit acceptance')
      const row = page.locator('[data-chat-flow-kind="user"]').first()
      const edit = row.getByRole('button', { name: 'Edit', exact: true })
      const copy = row.getByRole('button', { name: 'Copy', exact: true })
      expect(await edit.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await copy.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await page.locator('[data-chat-flow-kind="assistant-step"]').getByRole('button', { name: 'Edit', exact: true }).count()).toBe(0)
      await edit.click()
      const editor = page.getByRole('textbox', { name: 'Edit prompt' })
      expect(await editor.inputValue()).toBe('My name is Alice.')
      await editor.fill('discard')
      await editor.press('Escape')
      expect(await page.getByText('My name is Alice.', { exact: true }).count()).toBe(1)
      await edit.click()
      await editor.fill('My name is Bob.')
      const settled = scaffold.whenTurnSettled()
      await editor.press('Enter')
      const bob = await settled
      await page.getByText('My name is Bob.', { exact: true }).waitFor()
      for (const old of ['Nice to meet you, Alice.', 'What is my name?', 'Alice.']) {
        expect(await page.getByText(old, { exact: true }).count()).toBe(0)
        expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain(old)
      }
      await page.getByText('Hello from the active revision.', { exact: true }).waitFor()
      await page.reload()
      await page.getByText('My name is Bob.', { exact: true }).waitFor()
      expect(scaffold.ctx.sessions.get(bob)!.header.parentSession).toBe(original.id)
      await page.locator('[data-chat-flow-kind="user"]').getByRole('button', { name: 'Edit', exact: true }).click()
      await editor.fill('My name is Charlie.')
      const settledAgain = scaffold.whenTurnSettled()
      await editor.press('Enter')
      const charlie = await settledAgain
      await page.getByText('My name is Charlie.', { exact: true }).waitFor()
      await page.getByText('Hello from the active revision.', { exact: true }).waitFor()
      expect(scaffold.ctx.sessions.get(bob)!.deriveMessages().find(message => message.source.kind === 'user')!.content)
        .toEqual([{ type: 'text', text: 'My name is Bob.' }])
      expect(scaffold.ctx.sessions.get(charlie)!.header.parentSession).toBe(bob)
      await compareOrRefreshGolden(golden, await captureStableAria(page, '[data-conversation-scroll]', scaffold.workspaceCwd), webSnapshotMode())
    } catch (error) { await saveFailureShot(page, 'prompt-revisions'); throw error }
  })

  it.each([100, 1000])('EDIT-025: edits the start of %i messages without retaining the old scroll path', async (messages) => {
    await source(`Long edit ${messages}`, messages / 2)
    await open(`Long edit ${messages}`)
    const earlier = page.getByRole('button', { name: 'Load earlier', exact: true })
    while (await earlier.count() > 0) {
      await earlier.click()
      await expect.poll(() => page.getByRole('button', { name: 'Loading…', exact: true }).count()).toBe(0)
    }
    const first = page.locator('[data-chat-flow-kind="user"]').first()
    await first.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'Edit prompt' })
    expect(await editor.inputValue()).toBe('My name is Alice.')
    await editor.fill(`New beginning ${messages}`)
    const settled = scaffold.whenTurnSettled()
    await editor.press('Enter')
    await settled
    await page.getByText(`New beginning ${messages}`, { exact: true }).waitFor()
    await page.getByText('Hello from the active revision.', { exact: true }).waitFor()
    expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(1)
    expect(await page.getByText(`Old answer ${messages / 2}`, { exact: true }).count()).toBe(0)
    const geometry = await page.locator('[data-conversation-scroll]').evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }))
    expect(geometry.top).toBeLessThanOrEqual(Math.max(0, geometry.height - geometry.client))
  })

  it('EDIT-004–007/016–021: retains exact failed drafts, retries generation once, and keeps a stopped branch active', async () => {
    const text = '  Tiếng Việt 🐉\nDòng thứ hai  '
    const original = await source('Retry editor acceptance', 1, [{ type: 'text', text }])
    await open('Retry editor acceptance')
    const edit = page.locator('[data-chat-flow-kind="user"]').getByRole('button', { name: 'Edit', exact: true })
    await edit.click()
    const editor = page.getByRole('textbox', { name: 'Edit prompt' })
    expect(await editor.inputValue()).toBe(text)
    expect(await editor.evaluate(element => element === document.activeElement)).toBe(true)
    await editor.press('ControlOrMeta+A')
    await page.keyboard.insertText('Undo tiếng Việt')
    await editor.press('ControlOrMeta+Z')
    expect(await editor.inputValue()).toBe(text)
    await editor.press('ControlOrMeta+Shift+Z')
    expect(await editor.inputValue()).toBe('Undo tiếng Việt')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: scaffold.baseUrl })
    await editor.press('ControlOrMeta+A')
    await editor.press('ControlOrMeta+C')
    await editor.press('ArrowRight')
    await editor.press('ControlOrMeta+V')
    expect(await editor.inputValue()).toBe('Undo tiếng ViệtUndo tiếng Việt')
    await editor.fill(' \n ')
    expect(await page.getByRole('button', { name: 'Save & resend', exact: true }).isDisabled()).toBe(true)
    await editor.fill('')
    expect(await page.getByRole('button', { name: 'Save & resend', exact: true }).isDisabled()).toBe(true)
    await editor.fill('  Sửa prompt 🐉')
    await editor.press('Shift+Enter')
    await editor.press('x')
    const draft = await editor.inputValue()
    expect(draft).toBe('  Sửa prompt 🐉\nx')
    const before = scaffold.ctx.sessions.list().length
    await page.route('**/api/session.revise', route => route.fulfill({ status: 503, body: 'Temporarily offline' }), { times: 1 })
    await editor.press('Enter')
    await page.getByRole('alert').filter({ hasText: 'Could not send the edited prompt' }).waitFor()
    expect(await editor.inputValue()).toBe(draft)
    expect(scaffold.ctx.sessions.list()).toHaveLength(before)
    adapter.mode = 'fail'
    let settled = scaffold.whenTurnSettled()
    await editor.press('Enter')
    const failedId = await settled
    const retry = page.getByRole('button', { name: 'Retry response', exact: true })
    await retry.waitFor()
    settled = scaffold.whenTurnSettled()
    await retry.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
    const retriedId = await settled
    await page.getByText('Hello from the active revision.', { exact: true }).waitFor()
    const failed = scaffold.ctx.sessions.get(failedId)!
    const retried = scaffold.ctx.sessions.get(retriedId)!
    const humanId = (session: Session) => session.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')?.data
    expect(humanId(retried)).toEqual(humanId(failed))
    expect(scaffold.ctx.sessions.list()).toHaveLength(before + 2)
    expect(original.events.some(event => event.type === 'user/message' && JSON.stringify(event.data.content).includes('Tiếng Việt'))).toBe(true)
    await edit.click()
    await editor.fill('Stop this edited response')
    adapter.mode = 'hang'
    settled = scaffold.whenTurnSettled()
    await editor.press('Enter')
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    const stopped = await settled
    await retry.waitFor()
    await page.reload()
    await page.getByText('Stop this edited response', { exact: true }).waitFor()
    await retry.waitFor()
    expect(scaffold.ctx.sessions.get(stopped)!.events.at(-1)?.data).toMatchObject({ reason: { kind: 'aborted' } })
  })
})
