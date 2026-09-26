/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkPackageNamespace,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@hydra1902/harness-experimental-prototype', private: true },
}

describe('package namespace', () => {
  it('accepts Hydra families and rejects foreign or missing names', () => {
    expect(checkPackageNamespace(experimental)).toEqual([])
    expect(checkPackageNamespace({ dir: 'apps/cli', manifest: { name: '@hydra1902/harness' } })).toEqual([])
    expect(checkPackageNamespace({ dir: 'vendor/cordis', manifest: { name: '@hydra1902/cordis' } })).toEqual([])
    for (const name of ['@legacy/hydra-agent', '@hydra1902/agent', undefined]) {
      expect(checkPackageNamespace({ dir: 'packages/core/agent', manifest: name === undefined ? {} : { name } })).toHaveLength(1)
    }
  })
})

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@hydra1902/harness-prototype' },
    })).toEqual([
      '@hydra1902/harness-prototype: experimental package name must start with "@hydra1902/harness-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@hydra1902/harness-experimental-prototype: experimental package must set "private": true',
      '@hydra1902/harness-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@hydra1902/harness-consumer',
          [section]: { '@hydra1902/harness-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@hydra1902/harness-consumer: ${section}.@hydra1902/harness-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@hydra1902/harness-test-only',
        devDependencies: { '@hydra1902/harness-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@hydra1902/harness-experimental-consumer',
        dependencies: { '@hydra1902/harness-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@hydra1902/harness-python-runtime',
        dependencies: { '@hydra1902/harness-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@hydra1902/harness-python-runtime: dependencies.@hydra1902/harness-experimental-prototype must not reference an experimental package',
    ])
  })
})
