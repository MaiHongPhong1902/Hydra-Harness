import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@bosch/bh-client-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
