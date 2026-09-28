// @vitest-environment jsdom
/** Explicit search saves retain provider drafts, credentials, and in-flight edits. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubSettingsScope, bindSnapshotSelector } from '@hydraharness/harness-client-test-runtime'
import type { IApiClient } from '@hydraharness/harness-client-connection/client'
import type { WebSearchProviderDescriptor } from '@hydraharness/harness-host-apiproxy/api'
import { WebSearchCardController } from '../src/client/web-search-card-controller.ts'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const descriptors: WebSearchProviderDescriptor[] = ['first', 'second'].map(id => ({
  id, displayName: id, configurable: true, settingsNs: id, credentialRef: `${id.toUpperCase()}_KEY`,
  capabilities: { web: true, images: false, news: false, videos: false, academic: false },
  fields: [
    { key: 'model', kind: 'text', label: 'Search Model' },
    ...id === 'first' ? [{ key: 'apiKeyEnv', kind: 'text' as const, label: 'Credential Reference', advanced: true }] : [],
  ],
}))

async function bench(directory = descriptors) {
  const scopes = new Map(['web-search', 'first', 'second'].map((ns) => {
    const host = stubSettingsScope<Record<string, unknown>>()
    host.publish({ status: 'ready', writable: true, value: ns === 'web-search' ? { provider: 'first', enabled: true, maxQueries: 4, maxResults: 8, timeoutMs: 60000 } : { model: 'original' }, user: {} })
    host.set.mockImplementation((field: string, value: unknown) => {
      const current = host.scope.getSnapshot()
      host.publish({ value: { ...current.value, [field]: value }, user: { ...current.user as object, [field]: value } })
    })
    return [ns, host] as const
  }))
  const describe = vi.fn<IApiClient['credentials']['describe']>(async ({ refs }) => ({ rpcId: 'c' as never, result: { ok: true as const, value: { credentials: Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }])) } } }))
  const set = vi.fn(async () => ({ rpcId: 'c' as never, result: { ok: true as const, value: {} } }))
  const unset = vi.fn(async () => ({ rpcId: 'c' as never, result: { ok: true as const, value: {} } }))
  const testConnection = vi.fn<IApiClient['webSearch']['testConnection']>(async () => ({ rpcId: 'c' as never, result: { ok: true as const, value: { connected: true as const, provider: 'first', resultCount: 2 } } }))
  const api: Pick<IApiClient, 'credentials' | 'webSearch'> = {
    credentials: { describe, set, unset },
    webSearch: { providers: async () => ({ rpcId: 'c' as never, result: { ok: true, value: { providers: directory } } }), testConnection },
  }
  const controller = new WebSearchCardController(scopes.get('web-search')!.scope, api, ns => scopes.get(ns)!.scope)
  const face = controller.inject()
  const state = () => face.hooks.webSearchCard.getSnapshot()
  await vi.waitFor(() => { expect(state().loading).toBe(false); expect(state().apiKeyConfigured).toBe(true) })
  return { controller, scopes, face, state, set, unset, describe, testConnection, api }
}

describe('Web Search Settings', () => {
  it('retries a failed directory load without replacing edited provider forms', async () => {
    const b = await bench()
    const providers = vi.spyOn(b.api.webSearch, 'providers').mockResolvedValueOnce({ rpcId: 'r' as never,
      result: { ok: false, error: { code: 'internal', message: 'unavailable', details: {} } } })
    b.face.editProvider('model', 'draft')
    b.face.reload()
    await vi.waitFor(() => { expect(b.state().loadFailed).toBe(true) })
    b.face.reload()
    await vi.waitFor(() => { expect(b.state().loading).toBe(false); expect(b.state().loadFailed).toBe(false) })
    expect(providers).toHaveBeenCalledTimes(2)
    expect(b.state().providerFields.model?.text).toBe('draft')
    b.face.reload()
    b.controller.dispose()
    await Promise.resolve()
  })

  it('refreshes credential status and ignores obsolete status responses', async () => {
    const b = await bench()
    const stale = Promise.withResolvers<Awaited<ReturnType<IApiClient['credentials']['describe']>>>()
    b.describe.mockReturnValueOnce(stale.promise)
    b.controller.refreshCredential('not-selected')
    b.controller.refreshCredential('FIRST_KEY')
    b.describe.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: true, value: { credentials: {} } } })
    b.face.editProvider('apiKeyEnv', 'NEW_KEY')
    await vi.waitFor(() => { expect(b.state().apiKeyWritable).toBe(false) })
    stale.reject(new Error('stale'))
    await Promise.resolve()
    b.describe.mockRejectedValueOnce(new Error('unavailable'))
    b.controller.refreshCredential('NEW_KEY')
    await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(false) })
    b.describe.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: false, error: { code: 'internal', message: 'unavailable', details: {} } } })
    b.controller.refreshCredential('NEW_KEY')
    await Promise.resolve()
    b.face.discard()
    await vi.waitFor(() => { expect(b.state().apiKeyConfigured).toBe(true) })
    b.controller.dispose()
  })

  it.each(['success', 'business', 'provider', 'transport', 'stale-error'])('reports a connection probe: %s', async (kind) => {
    const b = await bench()
    if (kind === 'business') b.testConnection.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: false, error: { code: 'internal', message: 'unavailable', details: {} } } })
    if (kind === 'provider') b.testConnection.mockResolvedValueOnce({ rpcId: 'r' as never, result: { ok: true, value: { connected: false, provider: 'first', code: 'AUTH_ERROR', retryable: false, message: 'sign in' } } })
    if (kind === 'transport' || kind === 'stale-error') b.testConnection.mockRejectedValueOnce(new Error('offline'))
    b.face.testConnection()
    b.face.testConnection()
    if (kind === 'stale-error') b.face.edit('provider', 'second')
    await vi.waitFor(() => { expect(b.state().testing).toBe(false) })
    expect(b.testConnection).toHaveBeenCalledOnce()
    expect(b.state().connectionStatus).toBe(kind === 'success' ? 'Connected. Search returned 2 results.'
      : kind === 'provider' ? 'AUTH_ERROR: sign in' : kind === 'stale-error' ? '' : 'Connection test failed.')
    b.controller.dispose()
  })

  it('blocks invalid or duplicate saves and retains pending edits when discard is requested', async () => {
    const b = await bench()
    b.face.edit('maxQueries', 'invalid')
    b.face.save()
    expect(b.state().saving).toBe(false)
    b.face.discard()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof b.set>>>()
    b.set.mockReturnValueOnce(pending.promise)
    b.face.editProvider('apiKey', 'replacement')
    b.face.save()
    b.face.save()
    b.face.discard()
    await vi.waitFor(() => { expect(b.set).toHaveBeenCalledOnce() })
    expect(b.state().apiKey.text).toBe('replacement')
    pending.resolve({ rpcId: 'r' as never, result: { ok: true, value: {} } })
    await vi.waitFor(() => { expect(b.state().saving).toBe(false) })
    b.face.edit('provider', '')
    b.face.editProvider('model', 'ignored')
    b.face.removeKey()
    expect(b.state().providerFields).toEqual({})
    b.controller.dispose()
  })

  it('renders directory failures, provider field kinds, key removal, and save status', async () => {
    const directory = descriptors.map(descriptor => ({ ...descriptor, fields: [...descriptor.fields,
      { key: 'auth', kind: 'select' as const, label: 'Authentication', options: ['key', 'none'], hint: 'Authentication mode' },
      { key: 'headers', kind: 'json' as const, label: 'Headers' },
      { key: 'limit', kind: 'number' as const, label: 'Provider limit' },
    ] }))
    const b = await bench(directory)
    const props = { ...b.face, t: (key: keyof typeof en) => en[key],
      useWebSearchCard: bindSnapshotSelector(b.face.hooks.webSearchCard) } as unknown as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    fireEvent.change(screen.getByLabelText('Search Model'), { target: { value: 'new model' } })
    fireEvent.change(screen.getByLabelText('Headers'), { target: { value: '{}' } })
    fireEvent.change(screen.getByLabelText('Provider limit'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Max Queries per Call'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByText('Removal pending Save')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    fireEvent.change(screen.getByLabelText('API Key / Header Value'), { target: { value: 'new-key' } })
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'none' } })
    expect(screen.queryByLabelText('API Key / Header Value')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search Provider'), { target: { value: 'second' } })
    const snapshot = b.state()
    await act(async () => { b.face.hooks.webSearchCard.set({ ...snapshot, loading: true, loadFailed: true, saving: true, failed: true,
      testing: true, connectionStatus: 'Probe result', apiKeyConfigured: false, fields: {}, providerFields: {},
      controls: [{ key: 'select', kind: 'select', label: 'Empty select' }, { key: 'json', kind: 'json', label: 'Empty JSON' }],
    }) })
    expect(screen.getByText('Loading search providers…')).not.toBeNull()
    expect(screen.getByText('Testing…')).not.toBeNull()
    expect(screen.getByText('Probe result')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => { b.face.edit('provider', '') })
    expect(screen.getByText('Select a search provider before using Web Search.')).not.toBeNull()
    b.controller.dispose()
  })

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
