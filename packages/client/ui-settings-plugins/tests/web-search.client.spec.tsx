// @vitest-environment jsdom
/** Explicit search saves retain provider drafts, credentials, and in-flight edits. */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope, bindSnapshotSelector } from '@hydra/harness-client-test-runtime'
import type { IApiClient } from '@hydra/harness-client-connection/client'
import type { WebSearchProviderDescriptor } from '@hydra/harness-host-apiproxy/api'
import { WebSearchCardController } from '../src/client/web-search-card-controller.ts'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import { en } from '../src/client/locales.ts'

const descriptors: WebSearchProviderDescriptor[] = ['first', 'second'].map(id => ({
  id, displayName: id, configurable: true, settingsNs: id, credentialRef: `${id.toUpperCase()}_KEY`,
  capabilities: { web: true, images: false, news: false, videos: false, academic: false },
  fields: [
    { key: 'model', kind: 'text', label: 'Search Model' },
    ...id === 'first' ? [{ key: 'apiKeyEnv', kind: 'text' as const, label: 'Credential Reference', advanced: true }] : [],
  ],
}))

async function bench() {
  const scopes = new Map(['web-search', 'first', 'second'].map((ns) => {
    const host = stubSettingsScope<Record<string, unknown>>()
    host.publish({ status: 'ready', writable: true, value: ns === 'web-search' ? { provider: 'first', enabled: true, maxQueries: 4, maxResults: 8, timeoutMs: 60000 } : { model: 'original' }, user: {} })
    host.set.mockImplementation((field: string, value: unknown) => {
      const current = host.scope.getSnapshot()
      host.publish({ value: { ...current.value, [field]: value }, user: { ...current.user as object, [field]: value } })
    })
    return [ns, host] as const
  }))
  const describe = vi.fn(async ({ refs }: { refs: string[] }) => ({ rpcId: 'c' as never, result: { ok: true as const, value: { credentials: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) } } }))
  const set = vi.fn(async () => ({ rpcId: 'c' as never, result: { ok: true as const, value: {} } }))
  const unset = vi.fn(async () => ({ rpcId: 'c' as never, result: { ok: true as const, value: {} } }))
  const testConnection = vi.fn(async () => ({ rpcId: 'c' as never, result: { ok: true as const, value: { connected: true as const, provider: 'first', resultCount: 2 } } }))
  const api: Pick<IApiClient, 'credentials' | 'webSearch'> = {
    credentials: { describe, set, unset },
    webSearch: { providers: async () => ({ rpcId: 'c' as never, result: { ok: true, value: { providers: descriptors } } }), testConnection },
  }
  const controller = new WebSearchCardController(scopes.get('web-search')!.scope, api, ns => scopes.get(ns)!.scope)
  const face = controller.inject()
  const state = () => face.hooks.webSearchCard.getSnapshot()
  await vi.waitFor(() => { expect(state().loading).toBe(false); expect(state().apiKeyConfigured).toBe(true) })
  return { controller, scopes, face, state, set, unset, describe, testConnection }
}

describe('Web Search Settings', () => {
  it('keeps independent provider drafts and activates selection only after Save', async () => {
    const b = await bench()
    b.face.editProvider('model', 'first-draft')
    b.face.edit('provider', 'second')
    b.face.editProvider('model', 'second-draft')
    b.face.edit('provider', 'first')
    expect(b.state().providerFields.model?.text).toBe('first-draft')
    expect(b.scopes.get('first')!.set).not.toHaveBeenCalled()
    b.face.edit('provider', 'second')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(b.scopes.get('web-search')!.scope.getSnapshot().value?.provider).toBe('second')
    expect(b.scopes.get('first')!.scope.getSnapshot().value?.model).toBe('first-draft')
    expect(b.set).not.toHaveBeenCalled()
    expect(b.unset).not.toHaveBeenCalled()
    b.controller.dispose()
  })

  it('saves an explicit empty mapping instead of restoring its default', async () => {
    const b = await bench()
    b.face.editProvider('model', '')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    expect(b.scopes.get('first')!.set).toHaveBeenCalledWith('model', '')
    b.controller.dispose()
  })

  it('retains edits made during Save and writes the credential to the captured reference', async () => {
    const b = await bench()
    let resolve!: () => void
    b.set.mockImplementationOnce(() => new Promise((done) => { resolve = () => { done({ rpcId: 'c' as never, result: { ok: true, value: {} } }) } }))
    b.face.editProvider('apiKey', 'submitted-key')
    b.face.edit('provider', 'second')
    b.face.save()
    await vi.waitFor(() => { expect(b.set).toHaveBeenCalled() })
    b.face.edit('provider', 'first')
    b.face.editProvider('apiKey', 'newer-key')
    b.face.editProvider('apiKeyEnv', 'DIFFERENT_KEY')
    resolve()
    await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
    expect(b.set).toHaveBeenCalledWith({ ref: 'FIRST_KEY', value: 'submitted-key' })
    expect(b.state()).toMatchObject({ dirty: true, provider: 'first', apiKey: { text: 'newer-key' } })
    expect(b.scopes.get('web-search')!.scope.getSnapshot().value?.provider).toBe('second')
    b.controller.dispose()
  })

  it('keeps failed writes retryable and stages credential removal', async () => {
    const b = await bench()
    b.set.mockRejectedValueOnce(new Error('connection lost'))
    b.face.editProvider('apiKey', 'replacement')
    b.face.save()
    await vi.waitFor(() => { expect(b.state()).toMatchObject({ failed: true, dirty: true, saving: false }) })
    expect(b.state().apiKey.text).toBe('replacement')
    b.face.save()
    await vi.waitFor(() => { expect(b.state().dirty).toBe(false) })
    b.face.removeKey()
    expect(b.unset).not.toHaveBeenCalled()
    expect(b.state().apiKey.cleared).toBe(true)
    b.face.save()
    await vi.waitFor(() => { expect(b.unset).toHaveBeenCalledWith({ ref: 'FIRST_KEY' }) })
    b.controller.dispose()
  })

  it('suppresses a connection result after the draft changed', async () => {
    const b = await bench()
    let resolve!: () => void
    b.testConnection.mockImplementationOnce(() => new Promise((done) => { resolve = () => { done({ rpcId: 'c' as never, result: { ok: true, value: { connected: true, provider: 'first', resultCount: 1 } } }) } }))
    b.face.testConnection()
    b.face.edit('provider', 'second')
    resolve()
    await vi.waitFor(() => { expect(b.state().testing).toBe(false) })
    expect(b.state().connectionStatus).toBe('')
    b.controller.dispose()
  })

  it('renders provider-owned controls, a masked configured key, and disabled search configuration', async () => {
    const b = await bench()
    const props = {
      ...b.face, t: (key: keyof typeof en) => en[key],
      useWebSearchCard: bindSnapshotSelector(b.face.hooks.webSearchCard),
    } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    expect(screen.getByRole('combobox', { name: 'Search Provider' })).toBeTruthy()
    expect(screen.getByLabelText('API Key / Header Value')).toHaveProperty('type', 'password')
    expect(screen.getByLabelText('API Key / Header Value')).toHaveProperty('value', '')
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(screen.getByLabelText('API Key / Header Value')).toHaveProperty('disabled', false)
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Web Search' })) })
    expect(screen.getByRole('combobox', { name: 'Search Provider' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Test Connection' })).toHaveProperty('disabled', true)
    b.controller.dispose()
  })
})
