/** Non-completion outcomes through the real Web loop, tools, projection, and themed UI. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/result-validation-turn/session.jsonl', import.meta.url))
const SNAPSHOT = fileURLToPath(new URL('./snapshots/todo-outcomes/panel.expected.md', import.meta.url))
const SHOTS = join(REPO_ROOT, '.artifacts', 'todo-outcomes')

describe.skipIf(webSnapshotMode() === 'record')('web e2e: todo outcomes', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await mkdir(SHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('keeps blocked, failed, and cancelled work distinct in both themes and a narrow viewport', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-todo-outcomes'))
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    await settled

    const panel = page.getByTestId('todo-panel')
    await panel.waitFor()
    expect(await panel.innerText()).toMatch(/1 blocked\s*·\s*1 failed\s*·\s*1 cancelled/)
    expect(await panel.innerText()).not.toMatch(/completed|pending/)
    await panel.getByRole('button').click()
    for (const status of ['blocked', 'failed', 'cancelled']) {
      const row = panel.locator(`li[data-status="${status}"]`)
      expect(await row.getByText(status[0]!.toUpperCase() + status.slice(1), { exact: true }).isVisible()).toBe(true)
    }
    await compareOrRefreshGolden(SNAPSHOT, await captureStableAria(page, '[data-testid="todo-panel"]', scaffold.workspaceCwd), webSnapshotMode())

    for (const theme of ['Light', 'Dark']) {
      await page.setViewportSize({ width: 1680, height: 1000 })
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Settings' })
      await dialog.getByRole('button', { name: 'General', exact: true }).click()
      await dialog.getByRole('button', { name: theme, exact: true }).click()
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'Dark' ? '' : null)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.screenshot({ path: join(SHOTS, `${theme.toLowerCase()}-todo.png`) })
      await page.setViewportSize({ width: 800, height: 800 })
      for (const status of ['blocked', 'failed', 'cancelled']) {
        const label = panel.locator(`li[data-status="${status}"] span`).last()
        expect(await label.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
      }
      await page.screenshot({ path: join(SHOTS, `${theme.toLowerCase()}-todo-narrow.png`) })
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
