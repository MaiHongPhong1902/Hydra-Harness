/** Keyless acceptance for session context actions through the assembled application. */
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@hydraharness/harness-session'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const ID = 'session-menu-acceptance'
const DIR = fileURLToPath(new URL('./snapshots/session-menu', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts', import.meta.url))

describe('web e2e: session context menu', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  // Overflow buttons are hidden until hover; role queries omit them while cold.
  const row = () => page.getByRole('treeitem').filter({ has: page.locator('button[aria-label^="Session actions for "]') })
  const context = async () => { await row().click({ button: 'right' }) }
  const choose = async (parent: string, child: string) => {
    await page.getByRole('menuitem', { name: parent, exact: true }).hover()
    await page.getByRole('menuitem', { name: child, exact: true }).click()
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SEED, 'utf8'), ID)
    await mkdir(join(scaffold.workspaceCwd, 'other'), { recursive: true })
    const other = await scaffold.ctx.workspaceRegistry.create(join(scaffold.workspaceCwd, 'other'))
    await other.setTitle('Other project')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: scaffold.baseUrl })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl)
    const ungrouped = page.getByRole('treeitem').filter({ hasText: 'Ungrouped' }).first()
    await ungrouped.waitFor()
    if (await ungrouped.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
    await row().waitFor()
    await mkdir(DIR, { recursive: true })
    await mkdir(ARTIFACTS, { recursive: true })
  }, 120_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('shows the requested action groups and keeps nested menus inside the viewport', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-menu-layout'))
    const selectedBefore = await row().getAttribute('aria-selected')
    await context()
    expect(await row().getAttribute('aria-selected')).toBe(selectedBefore)
    expect(await page.getByRole('menuitem', { name: 'Share', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('menuitem', { name: 'Share', exact: true }).textContent()).toContain('Coming soon')
    await compareOrRefreshGolden(join(DIR, 'menu.expected.md'), await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => {
        document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
        document.documentElement.style.colorScheme = theme
      }, theme)
      await page.screenshot({ path: join(ARTIFACTS, `session-menu-${theme}.png`) })
      await page.getByRole('menu').screenshot({ path: join(ARTIFACTS, `session-menu-${theme}-card.png`) })
    }
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 680, height: 560 })
    await context()
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).hover()
    const boxes = await page.locator('[role="menu"]').evaluateAll(menus => menus.map((menu) => {
      const rect = menu.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }))
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(11)
      expect(box.right).toBeLessThanOrEqual(669)
      expect(box.top).toBeGreaterThanOrEqual(11)
      expect(box.bottom).toBeLessThanOrEqual(549)
    }
    await page.screenshot({ path: join(ARTIFACTS, 'session-menu-narrow.png') })
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.mouse.move(1100, 700)
    await row().focus()
    await page.keyboard.press('Shift+F10')
    expect(await page.getByRole('menuitem', { name: 'Rename', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowDown')
    expect(await page.getByRole('menuitem', { name: 'Pin', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Other project')
    await page.keyboard.press('ArrowLeft')
    expect(await page.getByRole('menu').count()).toBe(1)
    expect(await page.getByRole('menuitem', { name: 'Project', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Escape')
  }, 60_000)

  it('persists organization, copies the transcript and directory, and opens the session link', async () => {
    onTestFailed(() => saveFailureShot(page, 'session-menu-actions'))
    await context()
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
    await page.getByRole('group', { name: 'Pinned', exact: true }).waitFor()
    expect(await row().count()).toBe(1)
    await context()
    await page.getByRole('menuitem', { name: 'Mark as unread' }).click()
    expect(await row().getByLabel('Unread').count()).toBe(1)
    const warningStart = tripwire.warnings.length
    await page.reload()
    await page.getByRole('group', { name: 'Pinned', exact: true }).waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await row().getByLabel('Unread').count()).toBe(1)
    await row().click()
    await expect.poll(() => row().getByLabel('Unread').count()).toBe(0)
    await context()
    await choose('Section', 'New section…')
    await page.getByRole('textbox', { name: 'Section name' }).fill('Review')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await context()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await page.getByRole('group', { name: 'Review', exact: true }).waitFor()
    await context()
    await choose('Project', 'Other project')
    const stored = (await scaffold.ctx.sessionPersistence.list()).find(header => header.id === SessionId(ID))
    expect(stored?.cwd).toBe(scaffold.workspaceCwd)
    await context()
    await choose('Copy', 'Copy working directory')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(scaffold.workspaceCwd)
    await context()
    await choose('Copy', 'Copy as Markdown')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('## Assistant')
    await context()
    await choose('Copy', 'Copy deeplink')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`session=${ID}`)
    await context()
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('menuitem', { name: 'Open in new window' }).click()
    const popup = await popupPromise
    await popup.getByRole('treeitem').filter({ has: popup.locator('button[aria-label^="Session actions for "]') }).waitFor()
    await expect.poll(() => popup.getByRole('treeitem', { selected: true }).count()).toBe(1)
    await popup.close()
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
