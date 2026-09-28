/** Pure first-run readiness projection over the shared Models join. */
import { describe, expect, it } from 'vitest'
import type { CredentialView, SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { onboardingReadiness, providerUsable } from '../src/client/store.ts'

const missingCredential: CredentialView = { configured: false, writable: true }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'deepseek-official',
      displayName: 'DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    credential: missingCredential,
    fallbackCredentials: {},
    ...overrides,
  }
}

/** A second provider the user configured themselves. */
function otherRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: {
      provider: 'hfai',
      displayName: 'HFAI',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'hfai'],
      active: true,
    },
    configured: true,
    removable: true,
    apiKeyEnv: 'HFAI_API_KEY',
    credential: { configured: true, source: 'file', writable: true },
    fallbackCredentials: {},
    ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready',
    error: null,
    credentialError: null,
    credentials: {},
    writable: true,
    rows: [row()],
    namespaces: new Map([['llm-deepseek', { ns: 'llm-deepseek' } as SettingsNamespaceView]]),
    officialDeepSeekDeclined: false,
    ...overrides,
  }
}

describe('providerUsable', () => {
  it('requires a registered route and a stored key for every named reference', () => {
    expect(providerUsable(otherRow())).toBe(true)
    expect(providerUsable(otherRow({ entry: { ...otherRow().entry, active: false } }))).toBe(false)
    expect(providerUsable(otherRow({ credential: missingCredential }))).toBe(false)
    expect(providerUsable(otherRow({ credential: undefined }))).toBe(false)
  })

  it('treats a reference-free registered route as provider-native authentication', () => {
    expect(providerUsable(otherRow({ apiKeyEnv: undefined, credential: undefined }))).toBe(true)
  })
})

describe('onboardingReadiness', () => {
  it('waits for the join, including refreshes with retained rows', () => {
    expect(onboardingReadiness(state({ status: 'idle', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ status: 'loading' }))).toEqual({ kind: 'loading' })
  })

  it('offers provider configuration without preferring official DeepSeek', () => {
    expect(onboardingReadiness(state())).toEqual({ kind: 'setup-needed' })
    expect(onboardingReadiness(state({ officialDeepSeekDeclined: true }))).toEqual({ kind: 'setup-needed' })
    expect(onboardingReadiness(state({
      rows: [otherRow({ credential: missingCredential })],
      namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai' } as SettingsNamespaceView]]),
    }))).toEqual({ kind: 'setup-needed' })
    expect(onboardingReadiness(state({
      rows: [row({ entry: { ...row().entry, active: false } })],
    }))).toEqual({ kind: 'setup-needed' })
  })

  it('skips setup for usable file, environment, or native authentication', () => {
    for (const usable of [
      otherRow(),
      row({ credential: { configured: true, source: 'env', writable: false } }),
      otherRow({ apiKeyEnv: undefined, credential: undefined }),
    ]) {
      expect(onboardingReadiness(state({ rows: [row(), usable] }))).toEqual({ kind: 'provider-ready' })
    }
  })

  it('leaves unavailable or read-only configuration to manual navigation', () => {
    for (const overrides of [
      { status: 'error' as const },
      { credentialError: 'credentials unavailable' },
      { writable: false },
      { rows: [] },
      { namespaces: new Map() },
    ]) {
      expect(onboardingReadiness(state(overrides))).toEqual({ kind: 'unavailable' })
    }
  })
})

it('accepts a configured fallback while requiring a credential for fallback-only profiles', () => {
  const available = row({ fallbackCredentials: { SECOND: { configured: true, writable: true } } })
  expect(providerUsable(available)).toBe(true)
  expect(onboardingReadiness(state({ rows: [available] }))).toEqual({ kind: 'provider-ready' })
  expect(providerUsable(otherRow({ apiKeyEnv: undefined, credential: undefined,
    fallbackCredentials: { SECOND: missingCredential } }))).toBe(false)
})
