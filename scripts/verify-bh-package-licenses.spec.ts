import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectBhPackageLicenses } from './verify-bh-package-licenses.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(root: string, file: string, manifest: Record<string, unknown>): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'bh-package-licenses-'))
  roots.push(root)
  writeManifest(root, 'package.json', {
    name: '@bosch/bh-root',
    license: 'MIT',
    workspaces: ['apps/*', 'packages/*/*', 'vendor/*'],
  })
  return root
}

describe('BH package license gate', () => {
  it('checks root, unhyphenated CLI, and bh-prefixed package names while ignoring other families', () => {
    const root = createWorkspace()
    writeManifest(root, 'apps/cli/package.json', { name: '@bosch/bh', license: 'MIT' })
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@bosch/bh-agent',
      license: 'BSD-3-Clause',
    })
    writeManifest(root, 'vendor/cordis/package.json', {
      name: '@bosch/cordis',
      license: 'BSD-3-Clause',
    })

    expect(inspectBhPackageLicenses(root)).toEqual({
      packageCount: 3,
      failures: [
        'packages/core/agent/package.json: @bosch/bh-agent must declare "license": "MIT"; found "BSD-3-Clause".',
      ],
    })
  })

  it('rejects a missing license declaration', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', { name: '@bosch/bh-agent' })

    expect(inspectBhPackageLicenses(root).failures).toEqual([
      'packages/core/agent/package.json: @bosch/bh-agent must declare "license": "MIT"; found undefined.',
    ])
  })
})
