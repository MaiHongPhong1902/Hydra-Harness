import { describe, expect, it } from 'vitest'
import { resolveProfiles } from '../src/config.ts'

describe('resolveProfiles', () => {
  it('rejects a non-positive onboarding attempt count', () => {
    expect(() => resolveProfiles({
      antigravity: { onboardingAttempts: 0 },
    })).toThrow(/onboardingAttempts must be a positive integer/)
  })

  it('rejects non-finite onboarding delays', () => {
    expect(() => resolveProfiles({
      antigravity: { onboardingDelayMs: Number.NaN },
    })).toThrow(/onboardingDelayMs must be non-negative/)
  })

  it('rejects negative onboarding delays', () => {
    expect(() => resolveProfiles({
      antigravity: { onboardingDelayMs: -1 },
    })).toThrow(/onboardingDelayMs must be non-negative/)
  })
})
