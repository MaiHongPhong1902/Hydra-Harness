import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const fixture = fileURLToPath(new URL('./snapshots/file-review/session.jsonl', import.meta.url))
const golden = fileURLToPath(new URL('./snapshots/file-review/ui.expected.md', import.meta.url))
const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))

it('reviews real Write/Edit results, keeps, rejects an older Undo and restores in reverse order after reload', async () => {
  const scaffold = await launchWebScaffold({ replayFixture: fixture, toolsMode: 'native', paceMs: 5 })
  const browser = await chromium.launch()
  const target = join(scaffold.workspaceCwd, 'workspace', 'review.txt')
  const page = await newEnglishPage(browser)
  const errors = watchConsole(page)
  // Review lives in the desktop right panel, which AppFrame mounts only when
  // the preload surface exists; the bounds call is inert for this scenario.
  await page.addInitScript(() => {
    const target = window as unknown as { hydraDesktop?: unknown }
    target.hydraDesktop = { browser: { setBounds() {} } }
  })
  const openReview = async () => {
    await page.getByRole('button', { name: 'Toggle right panel' }).click()
    await page.getByRole('button', { name: 'Choose panel' }).click()
    await page.getByRole('dialog', { name: 'Choose panel' })
      .getByRole('button', { name: 'Review', exact: true }).click()
  }
  try {
    await page.goto(scaffold.baseUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const settled = scaffold.whenTurnSettled()
    const composer = page.locator('textarea').first()
    await composer.fill('Write review.txt with A then edit A to B. Reply REVIEW_READY.')
    await composer.press('Enter')
    const sessionId = await settled
    await expect.poll(async () => (await scaffold.ctx.fileReview.list(sessionId)).length).toBe(2)
    expect(await readFile(target, 'utf8')).toBe('B\n')
    const inline = page.getByRole('region', { name: 'review.txt active', exact: true })
    await expect.poll(() => inline.count(), { timeout: 15_000 }).toBe(2)
    await openReview()
    const panel = page.getByRole('region', { name: 'Review', exact: true })
    await panel.getByText('2 changes · 1 file', { exact: true }).waitFor()
    const first = panel.getByRole('region', { name: 'review.txt active', exact: true }).first()
    await first.getByRole('button', { name: 'Keep', exact: true }).click()
    const kept = panel.getByRole('region', { name: 'review.txt kept', exact: true })
    await kept.getByRole('button', { name: 'Undo', exact: true }).click()
    await panel.getByRole('alert').waitFor()
    expect(await panel.getByRole('alert').textContent()).toContain('Undo was skipped')
    expect(await readFile(target, 'utf8')).toBe('B\n')
    await kept.locator('summary').click()
    expect(await kept.getByLabel('Recorded diff for review.txt').textContent()).toContain('+A')
    expect(await kept.textContent()).toContain('Tool call review-create')
    await mkdir(artifacts, { recursive: true })
    await page.screenshot({ path: join(artifacts, 'file-review-verified.png'), fullPage: true })
    await kept.locator('summary').click()
    await compareOrRefreshGolden(golden, await captureStableAria(page, '[aria-label="Review"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.reload()
    await openReview()
    const latest = panel.getByRole('region', { name: 'review.txt active', exact: true })
    await latest.locator('summary').click()
    expect(await latest.getByLabel('Recorded diff for review.txt').textContent()).toContain('-A\n+B')
    expect(await latest.textContent()).toContain('Tool call review-edit')
    await latest.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => readFile(target, 'utf8')).toBe('A\n')
    await kept.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.fileReview.list(sessionId)).map(c => c.state)).toEqual(['rolledBack', 'rolledBack'])
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect.poll(() => panel.getByRole('region', { name: 'review.txt rolledBack', exact: true }).count()).toBe(2)
    expect(errors.pageErrors).toEqual([])
    expect(errors.warnings).toEqual([])
  } catch (error: unknown) {
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, 'file-review-debug.txt'), JSON.stringify(errors) + '\n' + await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: join(artifacts, 'file-review.png'), fullPage: true })
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
