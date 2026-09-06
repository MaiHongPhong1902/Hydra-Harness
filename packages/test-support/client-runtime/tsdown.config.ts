import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  '@hydra/harness-client-test-runtime',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
