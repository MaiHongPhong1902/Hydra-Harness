/**
 * Mechanical guard for the coverage-exempt roster: each entry's positional
 * filter and exclude glob must select the same non-empty file set out of the
 * repository's spec inventory, so a renamed suite cannot silently fall out of
 * the uninstrumented gate while its exclude goes stale.
 */

import { globSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coverageExemptHeavySuites } from './coverage-exempt.ts'

const root = resolve(import.meta.dirname, '..')

/** The spec inventory mirrored from vitest.config.ts testIncludes. */
const allSpecs = new Set([
  ...globSync('packages/*/*/tests/**/*.spec.ts', { cwd: root }),
  ...globSync('packages/*/*/tests/**/*.spec.tsx', { cwd: root }),
  ...globSync('apps/*/tests/**/*.spec.ts', { cwd: root }),
  ...globSync('examples/*/tests/**/*.spec.ts', { cwd: root }),
  ...globSync('scripts/**/*.spec.ts', { cwd: root }),
].map(path => path.replaceAll('\\', '/')))

function excludeMatches(exclude: string): string[] {
  return globSync(exclude, { cwd: root })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => allSpecs.has(path))
    .sort()
}

function filterMatches(filter: string): string[] {
  return [...allSpecs].filter(spec => spec.startsWith(filter)).sort()
}

describe('coverage-exempt roster', () => {
  it.each(['', '1'])('selects native Electron independently of host source coverage with exemption mode %j', (mode) => {
    const output = execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', `
      import config from './vitest.config.ts';
      console.log(JSON.stringify({
        projects: config.test.projects.map(project => project.test.exclude),
        coverageExcludes: config.test.coverage.exclude,
      }));
    `], { cwd: root, env: { ...process.env, HYDRA_COVERAGE_EXEMPT_HEAVY: mode }, encoding: 'utf8', windowsHide: true })
    const config = JSON.parse(output) as { projects: string[][]; coverageExcludes: string[] }
    const nativeSuite = 'packages/browser/browser-electron/tests/electron.spec.ts'
    expect(config.projects).toHaveLength(2)
    for (const excludes of config.projects) {
      expect(excludes.includes(nativeSuite)).toBe(mode === '1')
    }
    expect(config.coverageExcludes).not.toContain('packages/browser/browser-electron/src/**/*.ts')
  })

  it.each(coverageExemptHeavySuites.map(suite => [suite.filter, suite] as const))(
    'filter and exclude select the same non-empty spec set for %s',
    (_filter, suite) => {
      const fromExclude = excludeMatches(suite.exclude)
      const fromFilter = filterMatches(suite.filter)
      expect(fromExclude.length).toBeGreaterThan(0)
      expect(fromFilter).toEqual(fromExclude)
    },
  )

  it('entries never overlap, so no suite is double-run or double-excluded', () => {
    const seen = new Map<string, string>()
    for (const suite of coverageExemptHeavySuites) {
      for (const spec of excludeMatches(suite.exclude)) {
        expect(seen.get(spec), `${spec} matched by ${seen.get(spec) ?? ''} and ${suite.exclude}`).toBeUndefined()
        seen.set(spec, suite.exclude)
      }
    }
  })
})
