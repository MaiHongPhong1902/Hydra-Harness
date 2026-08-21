import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  '@bosch/bh-client-test-runtime',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
