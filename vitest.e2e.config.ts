import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Keyless local-process, sandbox, and built-artifact integration tests.
const DEFAULT_E2E_MAX_WORKERS = 4

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const e2eMaxWorkers = positiveIntFromEnv('HYDRA_E2E_MAX_WORKERS', DEFAULT_E2E_MAX_WORKERS)

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the tsconfig.base.json paths facade (no include = match-all, so
  // client-package sources get mapping too — dropping /client subpath imports
  // onto package exports would load browser dist bundles into node).
  // Built-artifact e2e suites are unaffected: their built-ness lives in
  // subprocesses and createRequire lookups, which bypass vite resolution
  // entirely.
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    // apps/cli only, not apps/*: apps/web/tests/*.e2e.ts needs the built
    // frontend dist and runs under vitest.web.config.ts (the test:web job).
    include: ['packages/*/*/tests/**/*.e2e.ts', 'apps/cli/tests/**/*.e2e.ts', 'examples/*/tests/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: e2eMaxWorkers > 1,
    maxWorkers: e2eMaxWorkers,
  },
})
