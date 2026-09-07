/** Recorded fetch passages render through the real history RPC and chat renderer. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, parseSeedFixture, realizeSeedFixture, renderSeedFixture, seedSession, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const fixture = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/web-fetch/session.jsonl', import.meta.url))
const expected = fileURLToPath(new URL('./snapshots/web-citations/ui.expected.md', import.meta.url))

describe('web citations in recorded history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const decoded = parseSeedFixture(realizeSeedFixture(scaffold, await readFile(fixture, 'utf8'), 'web-citations'))
    const fetchResult = decoded.events.find(event => event.type === 'tool/result')
    if (fetchResult?.type !== 'tool/result') throw new Error('fixture has no fetch result')
    const result = fetchResult.data.message.content[0]
    if (result?.type !== 'tool-result' || result.content[0]?.type !== 'text') throw new Error('fetch result has no text')
    const id = /\nSource: ([a-f0-9]{64})\n/.exec(result.content[0].text)?.[1]
    if (id === undefined) throw new Error('fetch result has no source id')
    const finalText = `[Menu source](hydra-cite://${id} "Flat white") [Wrong quote](hydra-cite://${id} "invented price") [Missing source](hydra-cite://missing "Flat white")`
    const events = decoded.events.map((event) => {
      if (event.type === 'assistant/message' && event.data.step === 2) {
        return { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text' as const, text: finalText }] } } }
      }
      return event
    })
    await seedSession(scaffold, renderSeedFixture(decoded.headerLine, events), 'web-citations')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 30_000 })
    await group.click()
    await page.locator('[role="treeitem"]').nth(1).click()
  }, 120_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })
  it('links an exact recorded passage and leaves invalid citations inert', async () => {
    const link = page.getByRole('link', { name: 'Menu source', exact: true })
    await link.waitFor({ timeout: 20_000 })
    expect(await link.getAttribute('href')).toBe('http://127.0.0.1:43117/menu.html')
    expect(await link.getAttribute('title')).toBe('Flat white')
    expect(await link.getAttribute('data-passage-start')).not.toBeNull()
    expect(await page.getByRole('link', { name: 'Wrong quote', exact: true }).count()).toBe(0)
    expect(await page.getByRole('link', { name: 'Missing source', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(expected, await captureStableAria(page, 'body', scaffold.workspaceCwd), webSnapshotMode())
  })
})
