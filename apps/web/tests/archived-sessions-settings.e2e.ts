/** Keyless Settings acceptance for restoring an archived Session to its Workspace. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@hydra/harness-session'
import {
  launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SESSION_ID = 'archived-settings-restore'
const SESSION_ID_2 = 'archived-settings-restore-2'
const SESSION_TITLE = 'Use the read tool twice'

describe('web e2e: archived Sessions in Settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID)
    await seedSession(scaffold, await readFile(SEED, 'utf8'), SESSION_ID_2)
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(SessionId(SESSION_ID))
    await workspace.attachSession(SessionId(SESSION_ID_2))
    await scaffold.ctx.workspaceRegistry.archiveSession(SessionId(SESSION_ID))
    await scaffold.ctx.workspaceRegistry.archiveSession(SessionId(SESSION_ID_2))

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

  it('restores the archived session from Settings into its original Workspace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-archived-settings-restore'))
    const trigger = page.getByRole('button', { name: 'Settings', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.waitFor({ timeout: 10_000 })

    const archiveSection = dialog.getByRole('button', { name: 'Archived sessions', exact: true })
    await archiveSection.click()
    await dialog.getByRole('heading', { name: 'Archived sessions', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByText(SESSION_TITLE, { exact: true }).count(), { timeout: 10_000 })
      .toBe(2)

    const workspace = scaffold.ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('archived-session fixture has no Workspace')

    await dialog.getByRole('checkbox', { name: 'Select all' }).click()
    await dialog.getByRole('button', { name: 'Restore selected', exact: true }).click()
    await expect.poll(() => scaffold.ctx.workspaceRegistry.archivedSessionIds, { timeout: 10_000 }).toEqual([])
    expect(scaffold.ctx.workspaceRegistry.list()[0]?.sessionIds).toEqual(
      expect.arrayContaining([SessionId(SESSION_ID), SessionId(SESSION_ID_2)]),
    )
    await expect.poll(() => dialog.getByText(SESSION_TITLE, { exact: true }).count(), { timeout: 10_000 }).toBe(0)

    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    const group = page.getByRole('treeitem').filter({ hasText: workspace.title }).first()
    await group.waitFor({ timeout: 10_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    const groupSection = group.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
    await expect.poll(() => groupSection.getByText(SESSION_TITLE, { exact: true }).count(), { timeout: 10_000 }).toBe(2)
    expect(await page.getByRole('button', { name: 'Settings', exact: true }).evaluate(el => el === document.activeElement)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
