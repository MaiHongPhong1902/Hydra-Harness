import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@hydra/harness-client-ui-attachment',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
