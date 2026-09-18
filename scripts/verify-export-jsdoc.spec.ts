import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { collectExportJsdocViolations } from './verify-export-jsdoc.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('ignores temporary lint probes without exempting package exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'hydra-export-jsdoc-'))
  roots.push(root)
  const source = join(root, 'packages/demo/example/src')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'index.ts'), 'export function live(): void {}\n')
  writeFileSync(join(source, 'oxlint-contract-probe.ts'), 'export function probePromise(): void {}\n')

  const violations = collectExportJsdocViolations(root)

  expect(violations).toHaveLength(1)
  expect(violations[0]).toContain("exported function 'live'")
})
