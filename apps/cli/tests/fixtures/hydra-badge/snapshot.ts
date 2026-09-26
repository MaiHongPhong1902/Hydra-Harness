import { fileURLToPath } from 'node:url'
import { CallId } from '@hydra1902/harness-llm'
import { boot, loadOverlayPatches } from '@hydra1902/harness-app-boot'
import type {} from '@hydra1902/harness-skill'
import type {} from '@hydra1902/harness-tools'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('hydra-badge snapshot requires an overlay path')
const rootConfigPath = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot('hydra-badge-snapshot', rootConfigPath, [
  ...loadOverlayPatches('hydra-badge-snapshot', basePatchPath),
  ...loadOverlayPatches('hydra-badge-snapshot', overlayPath),
])

try {
  const search = await ctx.tools.execute({
    callId: CallId('hydra-badge-search'),
    name: 'skill_search',
    arguments: { query: 'Hydra badge pull request' },
    signal: new AbortController().signal,
  })
  const summary = (await ctx.skills.list()).find(skill => skill.name === 'hydra-badge')
  const result = await ctx.tools.execute({
    callId: CallId('hydra-badge-snapshot'),
    name: 'skill',
    arguments: { name: 'hydra-badge' },
    signal: new AbortController().signal,
  })
  process.stdout.write(`${JSON.stringify({ search, summary: summary ?? null, result })}\n`)
} finally {
  await ctx.fiber.dispose()
}
