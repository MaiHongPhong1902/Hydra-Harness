import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  '@hydra1902/harness-client-test-runtime',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
