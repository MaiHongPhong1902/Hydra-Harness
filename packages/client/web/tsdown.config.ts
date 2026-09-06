import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@hydra/harness-client-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
