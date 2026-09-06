// Real Web composition: settled message actions, before-turn editing, and
// persisted replies through a deterministic model adapter.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@hydra/harness-session'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@hydra/harness-llm'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, realizeSeedFixture, renderSeedFixture, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/message-actions', import.meta.url))
// Borrowed read-only: this scenario needs any settled user+assistant pair, not
// a new recording (workspace-management / sidebar-scrollbar pattern).
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const FORK_EXPECTED = join(SNAPSHOT_DIR, 'fork.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'message-actions-web-e2e'

/** Deterministic reply for edited prompts submitted through the real Host. */
class EditReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'edit-model', name: 'Edit model' }])
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Reply to the edited prompt.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
const MID_TURN_TEXT = 'I will read both files before answering.'
const SECOND_PROMPT = 'Now give the final answer.'

/**
 * Adapt the borrowed recording into response -> tools -> interrupted Think,
 * followed by one ordinary completed response. The first response keeps
 * copy/clock but is not a legal branch point; the second is the real turn tail.
 * @param raw - Recorded seeded-history JSONL.
 * @returns A contiguous, closed two-turn fixture.
 */
function completedTailFixture(raw: string): string {
  const decoded = parseSeedFixture(raw)
  const kept = decoded.events.filter(event => event.seq < 101).map((event) => {
    if (event.type === 'assistant/message' && event.seq === 64) {
      const data = event.data as unknown as { content?: unknown[] }
      const content = data.content
      if (!Array.isArray(content)) throw new Error('borrowed step-one assistant message has no content')
      return {
        ...event,
        data: { ...data, content: [...content.slice(0, 1), { type: 'text', text: MID_TURN_TEXT }, ...content.slice(1)] },
      }
    }
    return event
  })
  let seq = kept.length
  let time = (kept.at(-1)?.time ?? -1) + 1
  const at = (event: Record<string, unknown>): { seq: number; time: number } & Record<string, unknown> => ({
    ...event,
    seq: seq++,
    time: time++,
  })
  const tail = [
    at({ type: 'step/end', data: { turn: 1, step: 2 } }),
    at({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } }),
    at({ type: 'request/header', data: {
      header: { config: { provider: 'message-edit-test', model: 'edit-model' } }, reason: 'initial',
    } }),
    at({ type: 'turn/start', data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user', rpcId: '{{rpcId}}' } } } }),
    at({ type: 'user/message', data: { content: [{ type: 'text', text: SECOND_PROMPT }], source: { kind: 'user', rpcId: '{{rpcId}}' } }, surfaceOp: 'append' }),
    at({ type: 'step/start', data: { turn: 2, step: 1 } }),
    at({ type: 'assistant/message', data: { turn: 2, step: 1, content: [{ type: 'text', text: 'DONE' }], provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, sourceEventSeqs: [], surfaceOp: 'append' }),
    at({ type: 'step/end', data: { turn: 2, step: 1 } }),
    at({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }),
  ]
  return renderSeedFixture(decoded.headerLine, [...kept, ...tail])
}

describe('web e2e: message IconActions and clocks on settled history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const editAdapter = new EditReplyAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['message-edit-test'], editAdapter))
    const sessionCwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(sessionCwd, { recursive: true })
    await writeFile(join(sessionCwd, 'a.txt'), 'alpha\n')
    await writeFile(join(sessionCwd, 'b.txt'), 'beta\n')
    const raw = completedTailFixture(await readFile(SEED, 'utf8'))
    expect(fixtureUserPrompts(raw), 'adapted seed must carry both prompts').toEqual([PROMPT, SECOND_PROMPT])
    await seedSession(scaffold, raw, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('realizes Windows seed paths as valid JSON and remains idempotent', () => {
    const windows = { ...scaffold, workspaceCwd: 'C:\\seed "quoted"\\root' }
    const seed = JSON.stringify({ type: 'session', cwd: '{{cwd}}/workspace', id: '{{sessionId}}' }) + '\n'
    const realized = realizeSeedFixture(windows, seed, 'seed-test')
    expect((JSON.parse(realized) as { cwd: string }).cwd).toBe(windows.workspaceCwd)
    expect(realizeSeedFixture(windows, realized, 'seed-test')).toBe(realized)
  })

  it.skipIf(MODE === 'record')('enables branch only on the completed transcript tail', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(MID_TURN_TEXT, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // Focus-reveal the footers (hover:hover keeps them opacity-hidden until
    // hover/focus-within). Branch renders only under assistant answers — user
    // bubbles carry none — and only a completed transcript tail enables it.
    const copyButtons = page.getByRole('button', { name: 'Copy' })
    await expect.poll(() => copyButtons.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(4)
    await copyButtons.first().focus()
    const branchButtons = page.getByRole('button', { name: 'Branch into a new conversation' })
    await expect.poll(() => branchButtons.count(), { timeout: 5_000 }).toBe(2)
    await expect.poll(
      () => branchButtons.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-disabled'))),
      { timeout: 5_000 },
    ).toEqual(['true', null])
    await branchButtons.first().focus()
    await expect.poll(() => page.getByRole('tooltip').textContent(), { timeout: 5_000 })
      .toBe('Available only on the last message of a completed turn')
    await expect.poll(() => page.locator('[data-chat-flow-kind="user"]').getByRole('button', { name: 'Edit' }).count(),
      { timeout: 5_000 }).toBe(2)
  }, 60_000)

  it.skipIf(MODE === 'record')('matches the conversation aria golden with IconActions and clocks', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-actions-aria'))
    await page.getByRole('button', { name: /^Select model, current/ })
      .waitFor({ timeout: 10_000 })
    await page.getByText(/Cache hit \d+%/u).first().waitFor({ timeout: 10_000 })
    // Keep a footer focused so opacity-hidden actions stay in the a11y tree
    // as an active/focused control during the capture.
    await page.getByRole('button', { name: 'Copy' }).first().focus()
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('forks through the settled-message and session-row actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-fork'))
    // The last message action belongs to the completed second-turn assistant.
    await page.getByRole('button', { name: 'Branch into a new conversation' }).last().click()
    await expect.poll(
      () => scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === SessionId(SEED_ID)),
      { timeout: 15_000 },
    ).toBeDefined()
    await expect.poll(
      () => page.locator('[role="treeitem"]').count(),
      { timeout: 10_000 },
    ).toBe(3)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    // The row action owns a distinct ui-workspace injection from the message
    // action above, so exercise both through the loaded app before capture.
    const sourceRow = page.locator('[role="treeitem"][aria-selected="true"]')
    const rowBox = await sourceRow.boundingBox()
    if (rowBox === null) throw new Error('fork source row has no layout box')
    const actionButton = sourceRow.locator('button[aria-label^="Session actions for "]')
    await sourceRow.hover({ position: { x: rowBox.width - 16, y: rowBox.height / 2 } })
    await expect.poll(() => actionButton.isVisible(), { timeout: 2_000 }).toBe(true)
    const buttonBox = await actionButton.boundingBox()
    if (buttonBox === null) throw new Error('fork source row action has no layout box')
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
    await page.getByRole('menuitem', { name: 'Fork session' }).click()
    await expect.poll(
      () => scaffold.ctx.agents.list().filter(agent => agent.session.header.parentSession !== undefined).length,
      { timeout: 15_000 },
    ).toBe(2)
    await expect.poll(
      () => page.locator('[role="treeitem"]').count(),
      { timeout: 10_000 },
    ).toBe(4)
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').count(),
      { timeout: 10_000 },
    ).toBe(1)
    // The child row is published before its inherited title rename settles;
    // wait for that second RPC projection before freezing the ARIA tree.
    await expect.poll(
      () => page.locator('[role="treeitem"][aria-selected="true"]').textContent(),
      { timeout: 10_000 },
    ).toContain('Use the read tool twice (2)')
    const tree = await captureStableAria(
      page,
      '[role="tree"][aria-label="Sessions"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(FORK_EXPECTED, tree, MODE)
  })

  it.skipIf(MODE === 'record')('edits a sent prompt, keeps its prefix, and persists the new reply after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-message-edit'))
    const row = page.locator('[data-chat-flow-kind="user"]').last()
    const sessionRows = page.getByRole('tree', { name: 'Sessions', exact: true }).getByRole('treeitem')
    const countBefore = await sessionRows.count()
    await row.getByRole('button', { name: 'Edit' }).click()
    const editor = page.getByRole('textbox', { name: 'Edit prompt' })
    expect(await editor.inputValue()).toBe(SECOND_PROMPT)
    await editor.fill('discard this draft')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await row.textContent()).toContain(SECOND_PROMPT)
    expect(editAdapter.requests).toHaveLength(0)
    await row.getByRole('button', { name: 'Edit' }).click()
    await editor.fill('Please revise the answer.\nKeep it concise.')
    await page.getByRole('button', { name: 'Send', exact: true }).focus()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'edit.expected.md'),
      await captureStableAria(page, '[data-chat-flow-kind="user"]:has(textarea)', scaffold.workspaceCwd), MODE)
    await mkdir('.artifacts/prompt-edit', { recursive: true })
    await editor.focus()
    await row.screenshot({ path: '.artifacts/prompt-edit/inline-edit.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
    await row.screenshot({ path: '.artifacts/prompt-edit/inline-edit-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })
    const originals = new Map(scaffold.ctx.agents.list().map(agent => [agent.id, [...agent.session.events]]))
    const settled = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const childId = await settled
    const child = scaffold.ctx.agents.get(childId)!
    expect(child.session.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user'
      ? [event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')] : []))
      .toEqual([PROMPT, 'Please revise the answer.\nKeep it concise.'])
    const sourceId = child.session.header.parentSession!
    expect(scaffold.ctx.agents.get(sourceId)!.session.events).toEqual(originals.get(sourceId))
    const ended = child.session.events.findLast(event => event.type === 'turn/end')?.data
    expect(ended, JSON.stringify(ended)).toMatchObject({ reason: { kind: 'completed' } })
    expect(editAdapter.requests, JSON.stringify(child.session.events.filter(event => event.type.includes('error')))).toHaveLength(1)
    expect(JSON.stringify(editAdapter.requests[0]!.messages)).not.toContain(SECOND_PROMPT)
    await page.getByText('Reply to the edited prompt.', { exact: true }).waitFor()
    await expect.poll(() => sessionRows.count()).toBe(countBefore)
    await page.getByText('Current version', { exact: true }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'versions.expected.md'),
      await captureStableAria(page, 'nav[aria-label="Prompt versions"]', scaffold.workspaceCwd), MODE)
    await page.reload()
    await page.getByText('Please revise the answer.', { exact: false }).waitFor({ timeout: 15_000 })
    await page.getByText('Reply to the edited prompt.', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => sessionRows.count()).toBe(countBefore)
    await page.getByRole('button', { name: 'See versions', exact: true }).click()
    await page.getByText('Version 1', { exact: true }).waitFor()
    await page.locator('[data-chat-flow-kind="user"]').last().getByText(SECOND_PROMPT, { exact: true }).waitFor()
    expect(await page.getByText('Reply to the edited prompt.', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Next version', exact: true }).click()
    await page.getByText('Current version', { exact: true }).waitFor()
    await page.getByText('Reply to the edited prompt.', { exact: true }).waitFor()
    await expect.poll(() => sessionRows.count()).toBe(countBefore)
    await page.getByRole('button', { name: 'Previous version', exact: true }).click()
    await page.getByText('Version 1', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'See versions', exact: true }).click()
    await page.getByText('Current version', { exact: true }).waitFor()
    await page.screenshot({ path: '.artifacts/prompt-versions/current-version.png' })
    await page.locator('[data-chat-flow-kind="user"]').last().getByRole('button', { name: 'Edit' }).click()
    await editor.fill('Revise this answer once more.')
    const revisedAgain = scaffold.whenTurnSettled()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await revisedAgain
    await page.getByText('Revise this answer once more.', { exact: true }).waitFor()
    await expect.poll(() => sessionRows.count()).toBe(countBefore)
    expect(editAdapter.requests).toHaveLength(2)
    expect(JSON.stringify(editAdapter.requests[1]!.messages)).not.toContain('Keep it concise.')
    await page.getByRole('button', { name: 'See versions', exact: true }).click()
    await page.getByText('Version 2', { exact: true }).waitFor()
    await page.getByText('Please revise the answer.', { exact: false }).waitFor()
    await page.getByRole('button', { name: 'Next version', exact: true }).click()
    await page.getByText('Revise this answer once more.', { exact: true }).waitFor()
    await expect.poll(() => sessionRows.count()).toBe(countBefore)
  })

  it.skipIf(MODE === 'record')('keeps a closed inventory and clean browser console', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['edit.expected.md', 'fork.expected.md', 'ui.expected.md', 'versions.expected.md'])
  })
})
