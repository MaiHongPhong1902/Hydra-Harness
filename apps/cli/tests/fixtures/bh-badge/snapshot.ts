import { fileURLToPath } from 'node:url'
import { CallId } from '@bosch/bh-llm'
import { boot, loadOverlayPatches } from '@bosch/bh-app-boot'
import type {} from '@bosch/bh-skill'
import type {} from '@bosch/bh-tools'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('bh-badge snapshot requires an overlay path')
const rootConfigPath = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot('bh-badge-snapshot', rootConfigPath, [
  ...loadOverlayPatches('bh-badge-snapshot', basePatchPath),
  ...loadOverlayPatches('bh-badge-snapshot', overlayPath),
])

try {
  const search = await ctx.tools.execute({
    callId: CallId('bh-badge-search'),
    name: 'skill_search',
    arguments: { query: 'bh badge pull request' },
    signal: new AbortController().signal,
  })
  const summary = (await ctx.skills.list()).find(skill => skill.name === 'bh-badge')
  const result = await ctx.tools.execute({
    callId: CallId('bh-badge-snapshot'),
    name: 'skill',
    arguments: { name: 'bh-badge' },
    signal: new AbortController().signal,
  })
  process.stdout.write(`${JSON.stringify({ search, summary: summary ?? null, result })}\n`)
} finally {
  await ctx.fiber.dispose()
}
