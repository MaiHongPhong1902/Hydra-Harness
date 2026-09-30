/**
 * The bundle's substance is its patch file: the `hydra.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@hydraharness/cordis-plugin-include'
import { evaluate } from '@hydraharness/cordis-plugin-loader'

describe('hydra-base bundle', () => {
  it('declares a parseable patch list through the hydra.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      hydra?: { bundle?: { patch?: string } }
    }
    expect(manifest.hydra?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.hydra!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown> }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.HYDRA_TELEMETRY_MODE || 'DISABLED'",
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'plugin-runtime')).toMatchObject({ name: '@hydraharness/harness-plugin-runtime' })
    expect(rows.find(row => row.id === 'research-policy')).toMatchObject({ name: '@hydraharness/harness-research-policy' })
    expect(rows.find(row => row.id === 'research-policy')?.config).toBeUndefined()
    expect(manifest.dependencies).not.toHaveProperty('@hydraharness/harness-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@hydraharness/harness-subagent-claude-code')
    expect(manifest.dependencies?.['@hydraharness/harness-plugin-runtime']).toBe('workspace:^')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })

  it.each([
    [undefined, undefined, true, 'en-US'],
    ['order-operator', undefined, false, 'en-US'],
    ['order-operator', 'vi-VN', false, 'vi-VN'],
  ] as const)('gates page memory for role=%s and locale=%s', (role, locale, disabled, expectedLocale) => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    const rows = (parsed as { insert?: {
      id?: string
      disabled: { __jsExpr: string }
      config: Record<string, { __jsExpr: string }>
    }[] }[]).flatMap(patch => patch.insert ?? [])
    const row = rows.find(candidate => candidate.id === 'page-memory')
    if (row === undefined) throw new Error('base patch must declare page-memory')
    const context = { process: { env: { HYDRA_PAGE_MEMORY_ROLE: role, HYDRA_PAGE_MEMORY_LOCALE: locale }, cwd: () => process.cwd() } }
    expect(Boolean(evaluate(context, row.disabled.__jsExpr))).toBe(disabled)
    expect(Object.fromEntries(Object.entries(row.config).map(([key, value]) => [key, evaluate(context, value.__jsExpr)]))).toEqual({
      workspaceDir: process.cwd(), role: role ?? '', locale: expectedLocale,
    })
  })
})
