import { describe, expect, it } from 'vitest'
import { resolveOxlintInvocation } from './run-oxlint.ts'

describe('Oxlint invocation', () => {
  it('preserves the ordinary default invocation', () => {
    expect(resolveOxlintInvocation(['.'], { PATH: '/bin' })).toEqual({
      args: ['.'],
      env: { PATH: '/bin' },
    })
  })

  it('bounds both worker pools from one setting', () => {
    expect(resolveOxlintInvocation(['.', '--fix'], { HYDRA_OXLINT_THREADS: '4', GOMAXPROCS: '12' })).toEqual({
      args: ['.', '--fix', '--threads=4'],
      env: { HYDRA_OXLINT_THREADS: '4', GOMAXPROCS: '4' },
    })
  })

  it('uses location-preserving diagnostics in CI', () => {
    expect(resolveOxlintInvocation(['.'], { CI: 'true', HYDRA_OXLINT_THREADS: '4' })).toEqual({
      args: ['.', '--format=unix', '--threads=4'],
      env: { CI: 'true', HYDRA_OXLINT_THREADS: '4', GOMAXPROCS: '4' },
    })
  })

  it('preserves an explicitly selected CI formatter', () => {
    expect(resolveOxlintInvocation(['.', '--format', 'github'], { CI: 'true' }).args)
      .toEqual(['.', '--format', 'github'])
  })

  it.each(['0', '-1', '1.5', 'auto'])('rejects invalid worker bound %s', (value) => {
    expect(() => resolveOxlintInvocation(['.'], { HYDRA_OXLINT_THREADS: value }))
      .toThrow('HYDRA_OXLINT_THREADS must be a positive integer')
  })

  it('rejects a competing direct worker bound', () => {
    expect(() => resolveOxlintInvocation(['.', '--threads=2'], { HYDRA_OXLINT_THREADS: '4' }))
      .toThrow('use HYDRA_OXLINT_THREADS instead')
  })
})
