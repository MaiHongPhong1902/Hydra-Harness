// Assembled web coverage for account-backed ChatGPT and Google Antigravity
// providers. The provider transport is a deterministic test adapter, while
// authorization still crosses the real Host RPC and credentials services.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { credentialKey } from '@hydra/harness-credentials'
import {
  ACCOUNT_AUTH_PROVIDERS,
} from './account-auth-fixture.ts'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/auth-accounts', import.meta.url))
const CONNECTED_EXPECTED = join(SNAPSHOT_DIR, 'connected.expected.md')
const ACCOUNT_AUTH_OVERLAY = fileURLToPath(new URL('./auth-accounts.overlay.yml', import.meta.url))
const ACCOUNT_AUTH_FIXTURE = new URL('./account-auth-fixture.ts', import.meta.url).href
const MODE = webSnapshotMode()

async function openModels(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Models', exact: true }).click()
  await dialog.getByText('Sign in with your accounts or enter API keys to use models from these providers.', { exact: true })
    .waitFor({ timeout: 10_000 })
  return dialog
}

async function openEditor(dialog: Locator, buttonName: string): Promise<void> {
  await dialog.getByRole('button', { name: buttonName, exact: true }).click()
  await dialog.getByText('Accounts', { exact: true }).waitFor({ timeout: 10_000 })
}

async function openAddEditor(dialog: Locator, provider: string): Promise<void> {
  const section = dialog.getByRole('region', { name: 'Account sign-in', exact: true })
  await section.getByRole('button', { name: 'Add sign-in provider', exact: true }).click()
  await dialog.getByLabel('Provider', { exact: true }).selectOption(provider)
  await dialog.getByText('Accounts', { exact: true }).waitFor({ timeout: 10_000 })
  expect(await section.getByRole('textbox', { name: 'API key', exact: true }).count()).toBe(0)
  expect(await section.getByLabel('Provider', { exact: true }).locator('option').allTextContents())
    .not.toContain('minimax-cn')
}

async function addAccount(dialog: Locator, providerName: string, label: string): Promise<void> {
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: `${providerName} account label`, exact: true })
  await input.waitFor({ timeout: 10_000 })
  const link = dialog.getByRole('link', { name: 'Open sign-in page', exact: true })
  expect(await link.getAttribute('href')).toBe(
    `https://auth.example.test/${providerName === 'ChatGPT' ? 'chatgpt' : 'antigravity'}`,
  )
  await input.fill(label)
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await dialog.getByText('Account connected. Apply to make this provider available in the model selector.', { exact: true })
    .waitFor({ timeout: 10_000 })
  await expect.poll(() => dialog.getByText(label, { exact: true }).count(), { timeout: 10_000 }).toBe(1)
}

async function applyEditor(dialog: Locator, buttonName: string): Promise<void> {
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
  await dialog.getByRole('button', { name: buttonName, exact: true }).waitFor({ timeout: 10_000 })
}

describe('web e2e: account-backed ChatGPT and Antigravity login', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: ACCOUNT_AUTH_OVERLAY,
      extraPatches: [{ insert: [{ id: 'llm-account-auth-fixture', name: ACCOUNT_AUTH_FIXTURE }] }],
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps API keys independent while adding, removing, and restoring multiple accounts', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auth-accounts'))
    const dialog = await openModels(page)

    const apiKeys = dialog.getByRole('region', { name: 'API keys', exact: true })
    await apiKeys.getByRole('button', { name: 'Add provider', exact: true }).click()
    const apiProvider = apiKeys.getByLabel('Provider', { exact: true })
    const options = await apiProvider.locator('option').allTextContents()
    expect(options).not.toContain('ChatGPT')
    expect(options).not.toContain('Google Antigravity')
    await apiProvider.selectOption('minimax-cn')
    await apiKeys.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-e2e-independent-primary')
    await apiKeys.getByRole('button', { name: 'Add API key', exact: true }).click()
    await apiKeys.getByLabel('Fallback API key 1', { exact: true }).fill('sk-e2e-independent-fallback')
    await applyEditor(dialog, 'Edit minimax-cn')
    await apiKeys.getByRole('img', { name: 'API key configured', exact: true }).waitFor({ timeout: 10_000 })

    await openAddEditor(dialog, 'chatgpt')
    const empty = dialog.getByText('No accounts connected.', { exact: true })
    await empty.waitFor({ timeout: 10_000 })
    expect(await empty.isVisible()).toBe(true)

    await dialog.getByRole('button', { name: 'Add account', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'ChatGPT account label', exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
    await dialog.getByText('Sign-in cancelled.', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('No accounts connected.', { exact: true }).count()).toBe(1)

    await addAccount(dialog, 'ChatGPT', 'alice@example.test')
    await applyEditor(dialog, 'Edit ChatGPT (chatgpt)')

    await openEditor(dialog, 'Edit ChatGPT (chatgpt)')
    await addAccount(dialog, 'ChatGPT', 'bob@example.test')
    // This capture proves the UI holds both identities before either one is removed.
    await compareOrRefreshGolden(
      CONNECTED_EXPECTED,
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd),
      MODE,
    )
    await dialog.getByRole('button', { name: 'Sign out alice@example.test', exact: true }).click()
    await expect.poll(() => dialog.getByText('alice@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => dialog.getByText('bob@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await applyEditor(dialog, 'Edit ChatGPT (chatgpt)')

    await openAddEditor(dialog, 'antigravity')
    await addAccount(dialog, 'Google Antigravity', 'google@example.test')
    await applyEditor(dialog, 'Edit Google Antigravity (antigravity)')

    const chatgptRecord = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'chatgpt'))
    expect(chatgptRecord).toMatchObject({
      kind: 'grant',
      payload: { accounts: [{ id: 'chatgpt-2', label: 'bob@example.test' }] },
    })
    const antigravityRecord = await scaffold.ctx.credentials.readRecord(credentialKey('llm-account-auth', 'antigravity'))
    expect(antigravityRecord).toMatchObject({
      kind: 'grant',
      payload: { accounts: [{ id: 'antigravity-1', label: 'google@example.test' }] },
    })

    // A browser reload must recover the account inventory from the persisted
    // records rather than from the React editor that just closed.
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const reopened = await openModels(page)
    const restoredApiKeys = reopened.getByRole('region', { name: 'API keys', exact: true })
    await restoredApiKeys.getByRole('button', { name: 'Edit minimax-cn', exact: true }).click()
    await restoredApiKeys.getByLabel('Fallback API key 1', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await restoredApiKeys.getByRole('textbox', { name: 'API key', exact: true }).inputValue()).toBe('')
    expect(await restoredApiKeys.getByLabel('Fallback API key 1', { exact: true }).inputValue()).toBe('')
    const storedKeys = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(storedKeys).toContain('sk-e2e-independent-primary')
    expect(storedKeys).toContain('sk-e2e-independent-fallback')
    await restoredApiKeys.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openEditor(reopened, 'Edit ChatGPT (chatgpt)')
    await expect.poll(() => reopened.getByText('bob@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()
    await openEditor(reopened, 'Edit Google Antigravity (antigravity)')
    await expect.poll(() => reopened.getByText('google@example.test', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await reopened.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.keyboard.press('Escape')

    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'auth-accounts-e2e')
    const trigger = page.getByRole('button', { name: /^Select model/ })
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    await page.getByRole('menuitem', { name: /Model/ }).click()
    const chatgptModel = page.getByRole('menuitemradio', { name: 'GPT-5 Test', exact: true })
    const antigravityModel = page.getByRole('menuitemradio', { name: 'Gemini 2.5 Test', exact: true })
    await chatgptModel.waitFor({ timeout: 10_000 })
    await antigravityModel.waitFor({ timeout: 10_000 })
    expect(await chatgptModel.isVisible()).toBe(true)
    expect(await antigravityModel.isVisible()).toBe(true)
    await page.getByRole('menuitemradio', { name: 'Gemini 2.5 Test', exact: true }).click()
    await expect.poll(() => trigger.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Select model, current Gemini 2.5 Test')
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])

    expect(ACCOUNT_AUTH_PROVIDERS.map(provider => provider.provider)).toEqual(['chatgpt', 'antigravity'])
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['connected.expected.md'])
  })
})
