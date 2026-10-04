/** Keyless Web acceptance for permanent Session deletion from both surfaces. */
import { mkdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@hydraharness/harness-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/session-delete', import.meta.url))
const DELETE_DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'delete-dialog.expected.md')
// Reuse committed no-model fixtures; this scenario owns no recording.
const ARCHIVED_SEED = fileURLToPath(new URL('./snapshots/seeded-history/seed.jsonl', import.meta.url))
const SIDEBAR_SEED = fileURLToPath(new URL('./snapshots/navigation-panes/seed.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const ARCHIVED_ID = 'session-delete-archived'
const SIDEBAR_ID = 'session-delete-sidebar'
const ARCHIVED_TITLE = 'Use the read tool twice'
const SIDEBAR_TITLE = 'NavScenario: first run bash to'

async function physicalArtifactExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('web e2e: permanent Session deletion', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let workspace: ReturnType<WebScaffold['ctx']['workspaceRegistry']['list']>[number]
  let archivedArtifact: string
  let sidebarArtifact: string

  async function workspaceSessionRow(title: string): Promise<Locator> {
    const group = page.getByRole('treeitem').filter({ hasText: workspace.title }).first()
    await group.waitFor({ timeout: 15_000 })
    const section = group.locator('xpath=ancestor::*[contains(@class, "groupSection")][1]')
    await expect.poll(async () => {
      if (await group.getAttribute('aria-expanded') !== 'true') {
        await group.click()
        await page.waitForTimeout(50)
      }
      return await section.locator('[role="treeitem"]').filter({
        has: page.locator('button[aria-label^="Session actions for "]'),
      }).count()
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    const row = section.locator('[role="treeitem"]').filter({ hasText: title }).filter({
      has: page.locator('button[aria-label^="Session actions for "]'),
    }).first()
    await row.waitFor({ timeout: 10_000 })
    return row
  }

  async function openDeleteDialog(row: Locator, direct = false): Promise<Locator> {
    if (direct) {
      await row.getByRole('button', { name: `Delete session ${ARCHIVED_TITLE}`, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete session', exact: true })
      await dialog.waitFor({ timeout: 10_000 })
      return dialog
    }
    await row.hover()
    const trigger = row.locator('button[aria-label^="Session actions for "]')
    await expect.poll(() => trigger.isVisible(), { timeout: 10_000 }).toBe(true)
    await trigger.click()
    await page.getByRole('menuitem', { name: 'Permanently delete', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete session', exact: true })
    await dialog.waitFor({ timeout: 10_000 })
    return dialog
  }

  async function assertDeleted(id: SessionId, artifact: string): Promise<void> {
    await expect.poll(
      async () => (await scaffold.ctx.sessionPersistence.list()).some(header => header.id === id),
      { timeout: 10_000 },
    ).toBe(false)
    await expect.poll(() => physicalArtifactExists(artifact), { timeout: 10_000 }).toBe(false)
    expect(workspace.sessionIds).not.toContain(id)
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).not.toContain(id)
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(ARCHIVED_SEED, 'utf8'), ARCHIVED_ID)
    await seedSession(scaffold, await readFile(SIDEBAR_SEED, 'utf8'), SIDEBAR_ID)
    workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    await workspace.attachSession(SessionId(ARCHIVED_ID))
    await workspace.attachSession(SessionId(SIDEBAR_ID))
    await scaffold.ctx.workspaceRegistry.archiveSession(SessionId(ARCHIVED_ID))

    const archivedHeader = (await scaffold.ctx.sessionPersistence.list())
      .find(header => header.id === SessionId(ARCHIVED_ID))
    const sidebarHeader = (await scaffold.ctx.sessionPersistence.list())
      .find(header => header.id === SessionId(SIDEBAR_ID))
    if (archivedHeader === undefined || sidebarHeader === undefined) {
      throw new Error('Session deletion fixtures did not materialize')
    }
    const archivedLocation = scaffold.ctx.sessionPersistence.locate(archivedHeader)
    const sidebarLocation = scaffold.ctx.sessionPersistence.locate(sidebarHeader)
    if (archivedLocation === undefined || sidebarLocation === undefined) {
      throw new Error('JSONL persistence did not expose Session artifacts')
    }
    archivedArtifact = archivedLocation.path
    sidebarArtifact = sidebarLocation.path
    expect(await physicalArtifactExists(archivedArtifact)).toBe(true)
    expect(await physicalArtifactExists(sidebarArtifact)).toBe(true)

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

  it('cancels safely, deletes an archived Session from Settings, then deletes a sidebar Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-delete'))

    const settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsTrigger.click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Archived sessions', exact: true }).click()
    await settings.getByRole('heading', { name: 'Archived sessions', exact: true })
      .waitFor({ timeout: 10_000 })
    await settings.getByText(ARCHIVED_TITLE, { exact: true }).waitFor({ timeout: 10_000 })

    const archivedRow = settings.getByRole('listitem').filter({ hasText: ARCHIVED_TITLE }).first()
    const cancelDialog = await openDeleteDialog(archivedRow, true)
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="Delete session"]',
      scaffold.workspaceCwd,
    )
    await mkdir(SNAPSHOT_DIR, { recursive: true })
    await compareOrRefreshGolden(DELETE_DIALOG_EXPECTED, snapshot, MODE)
    await cancelDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => cancelDialog.count(), { timeout: 10_000 }).toBe(0)
    expect(await settings.getByText(ARCHIVED_TITLE, { exact: true }).count()).toBe(1)
    expect((await scaffold.ctx.sessionPersistence.list()).map(header => header.id))
      .toContain(SessionId(ARCHIVED_ID))
    expect(workspace.sessionIds).toContain(SessionId(ARCHIVED_ID))
    expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds])
      .toContain(SessionId(ARCHIVED_ID))

    const confirmDialog = await openDeleteDialog(archivedRow, true)
    await confirmDialog.getByRole('button', { name: 'Delete session', exact: true }).click()
    await expect.poll(() => confirmDialog.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => settings.getByText(ARCHIVED_TITLE, { exact: true }).count(), { timeout: 10_000 })
      .toBe(0)
    await assertDeleted(SessionId(ARCHIVED_ID), archivedArtifact)

    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden', timeout: 10_000 })
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await page.getByText(ARCHIVED_TITLE, { exact: true }).count()).toBe(0)

    const sidebarRow = await workspaceSessionRow(SIDEBAR_TITLE)
    const sidebarCancel = await openDeleteDialog(sidebarRow)
    await sidebarCancel.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => sidebarCancel.count(), { timeout: 10_000 }).toBe(0)
    expect(await page.getByText(SIDEBAR_TITLE, { exact: true }).count()).toBe(1)
    expect((await scaffold.ctx.sessionPersistence.list()).map(header => header.id))
      .toContain(SessionId(SIDEBAR_ID))

    const sidebarConfirm = await openDeleteDialog(sidebarRow)
    await sidebarConfirm.getByRole('button', { name: 'Delete session', exact: true }).click()
    await expect.poll(() => sidebarConfirm.count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.getByText(SIDEBAR_TITLE, { exact: true }).count(), { timeout: 10_000 })
      .toBe(0)
    await assertDeleted(SessionId(SIDEBAR_ID), sidebarArtifact)

    const finalWarningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, finalWarningStart)
    expect(await page.getByText(ARCHIVED_TITLE, { exact: true }).count()).toBe(0)
    expect(await page.getByText(SIDEBAR_TITLE, { exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the Session deletion fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['delete-dialog.expected.md'])
  })
})
