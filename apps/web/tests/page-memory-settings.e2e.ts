/** Keyless Web acceptance for the Page Memory settings card and Host persistence. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as PageMemoryModule from '@hydra/harness-page-memory'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'

const SNAPSHOT = fileURLToPath(new URL('./snapshots/page-memory-settings/card.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PAGE_MEMORY_MODULE = new URL('../../../packages/knowledge/page-memory/lib/index.js', import.meta.url).href

describe('web e2e: Page Memory settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    if (MODE !== 'replay') await mkdir(new URL('./snapshots/page-memory-settings/', import.meta.url), { recursive: true })
    scaffold = await launchWebScaffold()
    const pageMemory = await import(PAGE_MEMORY_MODULE) as typeof PageMemoryModule
    await scaffold.ctx.plugin(pageMemory, {
      workspaceDir: scaffold.workspaceCwd,
      storageDir: scaffold.workspaceCwd,
      role: 'order-operator',
      locale: 'en-US',
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    consoleState = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    expect(consoleState?.pageErrors ?? []).toEqual([])
    expect(consoleState?.warnings ?? []).toEqual([])
    await browser?.close()
    await scaffold?.close()
  })

  it('stages, validates, saves, discards, resets, and reloads maxHistory through the Host', async () => {
    const settingsPath = join(scaffold.harnessHome, 'settings.yaml')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await settings.getByRole('tab', { name: 'Configuration', exact: true }).click()

    const card = settings.locator('[role="listitem"]').filter({ hasText: 'Page Memory' }).first()
    await card.getByRole('button', { name: 'Show settings: Page Memory', exact: true }).click()
    const history = card.getByLabel('Maximum history', { exact: true })
    await history.waitFor()
    expect(await history.inputValue()).toBe('256')
    await compareOrRefreshGolden(
      SNAPSHOT,
      await captureStableAria(page, '[role="listitem"]:has(button[aria-label$="Page Memory"])', scaffold.workspaceCwd),
      MODE,
    )

    const beforeStage = await readFile(settingsPath, 'utf8')
    await history.fill('64')
    expect(await readFile(settingsPath, 'utf8')).toBe(beforeStage)
    expect(await card.getByText('Unsaved', { exact: true }).count()).toBe(1)
    expect(await card.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(true)

    await history.fill('soon')
    expect(await history.getAttribute('aria-invalid')).toBe('true')
    await card.getByText('Enter a number, or leave blank to use the default.', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    expect(await readFile(settingsPath, 'utf8')).toBe(beforeStage)
    await card.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect.poll(() => history.inputValue()).toBe('256')
    expect(await card.getByText('Unsaved', { exact: true }).count()).toBe(0)

    await history.fill('64')
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => readFile(settingsPath, 'utf8')).toContain('maxHistory: 64')
    expect(await card.getByText('Unsaved', { exact: true }).count()).toBe(0)

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const reloadedSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await reloadedSettings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await reloadedSettings.getByRole('tab', { name: 'Configuration', exact: true }).click()
    const reloadedCard = reloadedSettings.locator('[role="listitem"]').filter({ hasText: 'Page Memory' }).first()
    await reloadedCard.getByRole('button', { name: 'Show settings: Page Memory', exact: true }).click()
    const reloadedHistory = reloadedCard.getByLabel('Maximum history', { exact: true })
    await expect.poll(() => reloadedHistory.inputValue()).toBe('64')

    await reloadedCard.getByRole('button', { name: 'Reset to default', exact: true }).click()
    await expect.poll(() => reloadedHistory.inputValue()).toBe('256')
    expect(await reloadedCard.getByText('Unsaved', { exact: true }).count()).toBe(1)
    await reloadedCard.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => readFile(settingsPath, 'utf8')).not.toContain('maxHistory: 64')

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const resetSettings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await resetSettings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await resetSettings.getByRole('tab', { name: 'Configuration', exact: true }).click()
    const resetCard = resetSettings.locator('[role="listitem"]').filter({ hasText: 'Page Memory' }).first()
    await resetCard.getByRole('button', { name: 'Show settings: Page Memory', exact: true }).click()
    await expect.poll(() => resetCard.getByLabel('Maximum history', { exact: true }).inputValue()).toBe('256')
    expect(await resetCard.getByRole('button', { name: 'Reset to default', exact: true }).count()).toBe(0)
  }, 60_000)
})
