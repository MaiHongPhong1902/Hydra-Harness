import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@hydra1902/harness-client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
