import { describe, expect, it } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '@hydraharness/harness-timeout'
import { resolveProfiles, type AccountProviderProfile } from '../src/config.ts'

describe('account provider settings', () => {
  it('keeps absent providers dormant and treats empty model lists as discovery', () => {
    expect(resolveProfiles(undefined).size).toBe(0)
    expect(resolveProfiles({ chatgpt: {}, antigravity: { models: [] } }))
      .toEqual(new Map([['chatgpt', {}], ['antigravity', {}]]))
  })

  it('detaches configured model rows and retains valid provider controls', () => {
    const models = [{ id: 'one' }, { id: 'two', name: 'Two', contextWindow: 4096, maxTokens: 1024 }]
    const profile: AccountProviderProfile = {
      models, endpoint: 'https://fixture.test', callbackPath: '/oauth/callback', callbackPort: 0,
      onboardingAttempts: 1, onboardingDelayMs: 0, defaultContextWindow: 8192,
      defaultMaxTokens: 2048, maxRequestImageBytes: 1024, streamIdleTimeoutMs: MAX_TIMER_DELAY_MS,
    }
    const resolved = resolveProfiles({ antigravity: profile }).get('antigravity')!
    expect(resolved).toEqual(profile)
    expect(resolved).not.toBe(profile)
    expect(resolved.models).not.toBe(models)
    expect(resolved.models?.[0]).not.toBe(models[0])
    models[1]!.name = 'Changed'
    expect(resolved.models?.[1]?.name).toBe('Two')
  })

  it('rejects unknown routes', () => {
    expect(() => resolveProfiles({ unknown: {} })).toThrow('unknown provider')
  })

  it.each<[keyof AccountProviderProfile, unknown[], string]>([
    ['endpoint', [' ', ''], 'empty endpoint'],
    ['callbackPath', ['callback', '/callback?query'], 'callbackPath'],
    ['callbackPort', [0.5, -1, 65536], 'callbackPort'],
    ['onboardingAttempts', [0.5, 0], 'onboardingAttempts'],
    ['onboardingDelayMs', [Infinity, -1], 'onboardingDelayMs'],
    ['defaultContextWindow', [1.5, 0], 'defaultContextWindow'],
    ['defaultMaxTokens', [1.5, 0], 'defaultMaxTokens'],
    ['streamIdleTimeoutMs', [Infinity, 0, MAX_TIMER_DELAY_MS + 1], 'streamIdleTimeoutMs'],
    ['maxRequestImageBytes', [1.5, 0], 'maxRequestImageBytes'],
  ])('rejects invalid %s values', (field, values, message) => {
    for (const value of values) {
      expect(() => resolveProfiles({ chatgpt: { [field]: value } })).toThrow(message)
    }
  })

  it.each([
    [{ id: '' }, 'empty model id'],
    [{ id: 'one', name: '' }, 'empty name'],
    [{ id: 'one', contextWindow: 0 }, 'contextWindow'],
    [{ id: 'one', contextWindow: 1.5 }, 'contextWindow'],
    [{ id: 'one', maxTokens: 0 }, 'maxTokens'],
    [{ id: 'one', maxTokens: 1.5 }, 'maxTokens'],
  ] as const)('rejects invalid model metadata %j', (model, message) => {
    expect(() => resolveProfiles({ chatgpt: { models: [model] } })).toThrow(message)
  })

  it('rejects duplicate model identifiers', () => {
    expect(() => resolveProfiles({ chatgpt: { models: [{ id: 'one' }, { id: 'one' }] } }))
      .toThrow('repeats model "one"')
  })
})
