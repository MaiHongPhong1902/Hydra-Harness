import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Hydra harness',
    short_name: 'Hydra',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/hydra.png',
      sizes: '256x256',
      type: 'image/png',
      purpose: 'any',
    }],
  })
})

it('ships the Hydra artwork shared with the desktop icon', async () => {
  expect(await readFile(join(DIST_ROOT, 'hydra.png'))).toEqual(await readFile(new URL('../../desktop/assets/hydra.png', import.meta.url)))
})
