import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@hydra1902/harness-api-remotes',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
