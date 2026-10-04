/** Standalone video generation presentation through the assembled loop and attachment storage. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { credentialRef } from '@hydraharness/harness-credentials'
import type { GenerateOptions } from '@hydraharness/harness-llm'
import { unzipSync } from 'fflate'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT } from './support.ts'

describe.skipIf(webSnapshotMode() === 'record').each(['complete', 'error'] as const)('web e2e: standalone media %s', (outcome) => {
  const FIXTURE = fileURLToPath(new URL('./snapshots/media-generation/session.jsonl', import.meta.url))
  const SHOTS = join(REPO_ROOT, '.artifacts/media-generation')
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let finish!: () => void
  let started!: () => void
  const generationStarted = new Promise<void>((resolve) => { started = resolve })
  const generationFinished = new Promise<void>((resolve) => { finish = resolve })
  let bytes: Buffer
  let server: Server
  const requests: Array<{ path: string; method: string; key: string | string[] | undefined; body: unknown }> = []
  const modelRequests: GenerateOptions[] = []

  beforeAll(async () => {
    bytes = await readFile(join(REPO_ROOT, 'apps/web/tests/snapshots/media-generation/tree.webm'))
    server = createServer((request, reply) => { void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = Buffer.concat(chunks).toString()
      requests.push({ path: request.url!, method: request.method!, key: request.headers['x-goog-api-key'],
        body: body === '' ? undefined : JSON.parse(body) as unknown,
      })
      if (request.url === '/v1beta/files/tree:download') {
        reply.writeHead(200, { 'Content-Type': 'video/webm' }); reply.end(bytes); return
      }
      const name = 'models/veo-3.1-generate-preview/operations/fixture-job'
      reply.writeHead(200, { 'Content-Type': 'application/json' })
      if (request.method === 'POST') { started(); reply.end(JSON.stringify({ name })); return }
      await generationFinished
      reply.end(JSON.stringify(outcome === 'error' ? { name, done: true, error: { message: 'private fixture refusal' } }
        : { name, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${baseURL}/files/tree:download` } }] } } }))
    })().catch((error: unknown) => { reply.destroy(error instanceof Error ? error : new Error(String(error))) }) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Video fixture server has no port')
    const baseURL = `http://127.0.0.1:${address.port}/v1beta`
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, extraPatches: [
      { id: 'tool-media', config: { video: { pollIntervalMs: 1 } } },
      { id: 'llm-pi-ai', config: { providers: { fixture: {
        api: 'google-generative-ai', baseURL, apiKeyEnv: 'HYDRA_VIDEO_FIXTURE_KEY',
        models: [{ id: 'veo-3.1-generate-preview', endpoints: ['videos'] }],
      } }, videoModel: { provider: 'fixture', model: 'veo-3.1-generate-preview' } } },
    ] })
    scaffold.ctx.on('llm/stream', (options, next) => {
      modelRequests.push(options)
      return next()
    }, { prepend: true })
    await scaffold.ctx.credentials.set(credentialRef('HYDRA_VIDEO_FIXTURE_KEY'), 'fixture-only-key')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await mkdir(SHOTS, { recursive: true })
  }, 120_000)

  afterAll(async () => {
    finish()
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        server?.closeAllConnections()
        if (server !== undefined) await new Promise<void>(resolve => server.close(() => { resolve() }))
      }
    }
  })

  it('keeps generation visible, renders native playback or failure, and replays it', async () => {
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    const userPrompt = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))[0]!
    await input.fill(userPrompt)
    await input.press('Enter')
    await generationStarted
    const card = page.locator('[data-media-generation="video"]')
    await card.locator('[data-media-placeholder]').waitFor()
    expect(await card.locator('[data-media-placeholder]').evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.width / box.height
    })).toBeCloseTo(16 / 9, 3)
    expect(await card.evaluate(element => element.closest('[data-chat-activity-group]') === null)).toBe(true)
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/snapshots/media-generation/pending.expected.md'),
      (await captureStableAria(page, '[data-media-generation="video"]', scaffold.workspaceCwd)).replaceAll(scaffold.baseUrl, '{{host}}'), webSnapshotMode())
    await page.screenshot({ path: join(SHOTS, `${outcome}-pending.png`) })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await card.locator('[data-media-placeholder]').evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
    finish()
    const sessionId = await settled
    expect(modelRequests).toHaveLength(2)
    expect(modelRequests.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    ])
    const guidance = modelRequests[0]!.tools!.filter(tool => ['image_generate', 'image_generate_google', 'video_generate'].includes(tool.name))
      .map(tool => ({ name: tool.name, parameters: tool.parameters }))
    expect(guidance).toHaveLength(3)
    for (const tool of guidance) expect(JSON.stringify(tool.parameters)).toContain('Refine the user request')
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/snapshots/media-generation/prompt-guidance.expected.json'),
      JSON.stringify(guidance, null, 2), webSnapshotMode())
    const session = scaffold.ctx.sessions.get(sessionId)!
    const message = session.events.find(event => event.type === 'user/message')!
    expect(message.data).toMatchObject({ content: [{ type: 'text', text: userPrompt }] })
    const call = session.events.find(event => event.type === 'tool/call')!
    const prompt = 'Static wide shot of a tree gently swaying in the wind. Landscape composition. Duration: 6 seconds. No people or on-screen text.'
    expect(call.data).toMatchObject({ name: 'video_generate' })
    expect(JSON.parse(call.data.arguments)).toEqual({ prompt, seconds: 6, size: '1280x720' })
    expect(requests.find(request => request.method === 'POST')?.body).toMatchObject({
      instances: [{ prompt }], parameters: { durationSeconds: 6, aspectRatio: '16:9' },
    })
    expect(await card.locator('p').first().textContent()).toBe(prompt)
    await card.locator('[data-media-placeholder]').waitFor({ state: 'detached' })
    if (outcome === 'complete') {
      await expect.poll(() => card.locator('footer').textContent()).toBe('veo-3.1-generate-preview')
      const video = card.locator('video')
      await video.waitFor()
      await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
      expect(await video.evaluate((element) => {
        const media = element as HTMLVideoElement
        const box = media.getBoundingClientRect()
        return Math.abs(box.width / box.height - media.videoWidth / media.videoHeight)
      })).toBeLessThan(0.001)
      expect(await video.getAttribute('autoplay')).toBeNull()
      await video.evaluate(async (element) => { await (element as HTMLVideoElement).play(); (element as HTMLVideoElement).pause() })
      const downloadEvent = page.waitForEvent('download')
      await card.getByRole('link', { name: 'Download video' }).click()
      const download = await downloadEvent
      expect(download.suggestedFilename()).toBe('generated-video.webm')
      expect(await readFile(await download.path())).toEqual(bytes)
      const response = await page.request.get(`${scaffold.baseUrl}/api/session.export?sessionId=${sessionId}`)
      expect(response.ok()).toBe(true)
      const files = unzipSync(new Uint8Array(await response.body()))
      const videoPath = Object.keys(files).find(path => path.endsWith('/generated-video.webm'))
      expect(videoPath).toBeDefined()
      expect(Buffer.from(files[videoPath!] as Uint8Array)).toEqual(bytes)
    } else expect(await card.getByRole('alert').innerText()).toContain('Video generation failed; the accepted job was not resubmitted.')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(requests.every(request => request.key === 'fixture-only-key')).toBe(true)
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/snapshots/media-generation/${outcome}.expected.md`),
      (await captureStableAria(page, '[data-media-generation="video"]', scaffold.workspaceCwd)).replaceAll(scaffold.baseUrl, '{{host}}'), webSnapshotMode())
    await page.screenshot({ path: join(SHOTS, `${outcome}-light.png`) })
    await page.reload({ waitUntil: 'load' })
    await card.waitFor()
    if (outcome === 'complete') await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    else expect(await card.getByRole('alert').innerText()).toContain('Video generation failed; the accepted job was not resubmitted.')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.getByRole('button', { name: 'Dark', exact: true }).click()
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 800, height: 800 })
    if (outcome === 'complete') expect(await card.locator('video').evaluate((element) => {
      const media = element as HTMLVideoElement
      const box = media.getBoundingClientRect()
      return Math.abs(box.width / box.height - media.videoWidth / media.videoHeight)
    })).toBeLessThan(0.001)
    await page.screenshot({ path: join(SHOTS, `${outcome}-dark-narrow.png`) })
    expect(await card.evaluate(element => element.getBoundingClientRect().right <= innerWidth)).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
