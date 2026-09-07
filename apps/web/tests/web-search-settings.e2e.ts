/** Search Settings → credentials → live provider → common tool, through the shipped composition. */
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '@hydra/harness-agent'
import { SessionId } from '@hydra/harness-session'
import { CallId } from '@hydra/harness-llm'
import { settingsNamespace } from '@hydra/harness-settings'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const snapshotDir = fileURLToPath(new URL('./snapshots/web-search-settings/', import.meta.url))

describe('Web Search provider settings', () => {
  let scaffold: WebScaffold
  let handle: AgentHandle
  let browser: Browser
  let page: Page
  let server: Server
  let endpoint: string
  let requests = 0
  const requestBodies: unknown[] = []
  let receivedKey: string | undefined
  let responseStatus = 200
  const secret = 'search-settings-fixture-credential'
  beforeAll(async () => {
    server = createServer((request, response) => {
      requests++
      receivedKey = String(request.headers['x-api-key'] ?? '')
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        requestBodies.push(JSON.parse(body) as unknown)
        response.writeHead(responseStatus, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(responseStatus === 200 ? { data: { items: [
          { name: 'Hydra docs', href: 'https://example.com/docs?utm_source=search#heading', description: 'Search provider reference.' },
          { name: 'Same docs', href: 'https://example.com/docs', description: 'Duplicate result.' },
          { name: 'Provider API', href: 'https://example.com/api', description: 'API documentation.' },
        ] } } : { error: secret }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Search fixture did not listen')
    endpoint = `http://127.0.0.1:${address.port}/search`
    scaffold = await launchWebScaffold({})
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('web-search-settings'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 30000 })
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Web Search', exact: true }).click()
  }, 120000)
  afterAll(async () => {
    await browser?.close()
    await handle?.dispose()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => { server?.close((error) => { if (error) reject(error); else resolve() }) })
  })

  it('starts unselected, saves Other, tests the real mapping, and uses it in web_search', async () => {
    const section = page.getByRole('region', { name: 'Web Search', exact: true })
    const select = section.getByRole('combobox', { name: 'Search Provider' })
    await select.waitFor()
    expect(await select.inputValue()).toBe('')
    expect(await select.locator('option').allTextContents()).toEqual(['Select provider…', 'DeepSeek', 'Serper.dev', 'Other'])
    await compareOrRefreshGolden(join(snapshotDir, 'fresh.expected.md'), await captureStableAria(page, 'section[aria-label="Web Search"]', scaffold.workspaceCwd), webSnapshotMode())
    const missing = await scaffold.ctx.tools.execute({ agent: handle.agent, callId: CallId('search-unconfigured'), name: 'web_search', arguments: { queries: ['docs'] }, signal: new AbortController().signal })
    expect(JSON.stringify(missing)).toContain('no search provider has been configured')

    await select.selectOption('custom')
    expect(await section.getByLabel('Country', { exact: true }).count()).toBe(0)
    expect(await section.getByLabel('Language', { exact: true }).count()).toBe(0)
    await section.getByLabel('Endpoint', { exact: true }).fill(endpoint)
    await section.getByLabel('API Key / Header Value').fill(secret)
    await section.getByLabel('Results Path', { exact: true }).fill('data.items')
    await section.getByLabel('Title Field', { exact: true }).fill('name')
    await section.getByLabel('URL Field', { exact: true }).fill('href')
    await section.getByLabel('Snippet Field', { exact: true }).fill('description')
    await section.getByText('Advanced Settings', { exact: true }).click()
    await section.getByLabel('Country Field', { exact: true }).fill('gl')
    await section.getByLabel('Language Field', { exact: true }).fill('hl')
    await section.getByText('Advanced Settings', { exact: true }).click()
    await section.getByLabel('Max Total Results', { exact: true }).fill('2')
    await section.getByLabel('Max Queries per Call', { exact: true }).fill('2')
    await section.getByLabel('Search Timeout (ms)', { exact: true }).fill('5000')
    expect(scaffold.ctx.web.searchPreferences()?.provider).toBe('')
    expect(requests).toBe(0)
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => section.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    expect(scaffold.ctx.web.searchPreferences()?.provider).toBe('custom')
    expect(scaffold.ctx.tools.get('web_search', handle.agent)?.timeoutMs).toBe(5000)
    const tooMany = await scaffold.ctx.tools.execute({ agent: handle.agent, callId: CallId('search-query-limit'),
      name: 'web_search', arguments: { queries: ['one', 'two', 'three'] }, signal: new AbortController().signal })
    expect(JSON.stringify(tooMany)).toContain('at most 2 queries')
    expect(requests).toBe(0)
    await section.getByRole('button', { name: 'Test Connection', exact: true }).click()
    await section.getByText('Connected. Search returned 2 results.').waitFor()
    expect(receivedKey).toBe(secret)
    const output = await scaffold.ctx.tools.execute({ agent: handle.agent, callId: CallId('search-configured'), name: 'web_search', arguments: { queries: ['Hydra docs', 'Hydra API'], country: 'VN', language: 'vi' }, signal: new AbortController().signal })
    expect(output.isError).not.toBe(true)
    expect(requestBodies[0]).not.toHaveProperty('gl')
    expect(requestBodies[0]).not.toHaveProperty('hl')
    expect(requestBodies.slice(1)).toEqual(expect.arrayContaining([
      { q: 'Hydra docs', num: 2, gl: 'vn', hl: 'vi' }, { q: 'Hydra API', num: 2, gl: 'vn', hl: 'vi' },
    ]))
    const schema = scaffold.ctx.tools.schemas(handle.agent).find(tool => tool.name === 'web_search')
    const prompt = (await scaffold.ctx.systemPrompt.assemble({ scope: handle.agent })).sections.find(section => section.name === 'tool:web_search')
    expect(schema).toBeDefined()
    expect(prompt).toBeDefined()
    await compareOrRefreshGolden(join(snapshotDir, 'agent.expected.md'),
      `${JSON.stringify(schema, null, 2)}\n\n${prompt?.text}`, webSnapshotMode())
    const text = output.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(text.match(/^- /gm)).toHaveLength(2)
    await compareOrRefreshGolden(join(snapshotDir, 'tool.expected.md'), text, webSnapshotMode())
    const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).not.toContain(secret)
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')).toContain(secret)
    expect(await page.content()).not.toContain(secret)
    await page.setViewportSize({ width: 520, height: 850 })
    expect(await section.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: '.hydra-build/search-settings-narrow.png' })
    await page.setViewportSize({ width: 1680, height: 1000 })
  }, 60000)

  it('preserves configuration on switching, normalizes probe failures, and removes credentials only on Save', async () => {
    const section = page.getByRole('region', { name: 'Web Search', exact: true })
    const select = section.getByRole('combobox', { name: 'Search Provider' })
    await select.selectOption('serper')
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => scaffold.ctx.web.searchPreferences()?.provider).toBe('serper')
    await select.selectOption('custom')
    expect(await section.getByLabel('Endpoint', { exact: true }).inputValue()).toBe(endpoint)
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => section.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    responseStatus = 401
    await section.getByRole('button', { name: 'Test Connection', exact: true }).click()
    await section.getByText('AUTH_ERROR:', { exact: false }).waitFor()
    expect(await page.content()).not.toContain(secret)
    const aria = await captureStableAria(page, 'section[aria-label="Web Search"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(snapshotDir, 'configured.expected.md'), aria.replaceAll(endpoint, 'http://127.0.0.1:SEARCH_PORT/search'), webSnapshotMode())
    await page.screenshot({ path: '.hydra-build/search-settings-configured.png' })
    await section.getByRole('button', { name: 'Remove', exact: true }).click()
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')).toContain(secret)
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')).includes(secret)).toBe(false)
    await section.getByRole('checkbox', { name: 'Enable Web Search' }).uncheck()
    await section.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => scaffold.ctx.settings.get(settingsNamespace('web-search'))).toMatchObject({ enabled: false })
    expect(await select.isDisabled()).toBe(true)
  }, 60000)
})
