// Real pixel playback under the Windows/Electron reduced-motion preference.
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('plays sidebar and hero logos on explicit hover even with reduced motion enabled', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      const marks = page.locator('svg[viewBox="0 0 256 256"]')
      await marks.first().waitFor({ state: 'visible' })
      expect(await marks.count()).toBe(2)
      for (const mark of await marks.all()) {
        const still = await mark.screenshot()
        await mark.hover()
        const frame = await mark.screenshot()
        await expect.poll(async () => await mark.screenshot(), { timeout: 5_000 }).not.toEqual(frame)
        await page.mouse.move(1600, 900)
        await expect.poll(async () => await mark.screenshot()).toEqual(still)
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
