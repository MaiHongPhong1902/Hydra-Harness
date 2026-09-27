// @vitest-environment jsdom
/** Multiple account login, prompt privacy, and editor-owned cancellation. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IApiClient, RpcResponse } from '@hydra1902/harness-api-remotes/client'
import Schema from '@hydra1902/schemastery'
import { ProviderAccounts } from '../src/client/ProviderAccounts.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { providerAccountKey, providerUsable } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)
const t = (key: keyof typeof en) => en[key]
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'accounts-test' as never, result: { ok: true, value } })
const flowKey = 'llm-account-auth/chatgpt'

it('adds a second account and signs out only the selected account', async () => {
  let accounts = [{ id: 'alice', label: 'alice@example.test' }]
  let answered = false
  const api = {
    list: vi.fn(async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, accounts }] })),
    begin: vi.fn(async () => ok({ attemptId: 'login' })),
    state: vi.fn(async () => ok({ attempt: answered
      ? { id: 'login', status: 'authorized' }
      : { id: 'login', status: 'running', notice: { message: 'Continue in your browser', url: 'https://example.test/login' },
        prompt: { id: 'code', kind: 'secret', message: 'Authorization code' } } })),
    answer: vi.fn(async () => {
      accounts = [...accounts, { id: 'bob', label: 'bob@example.test' }]
      answered = true
      return ok({})
    }),
    cancel: vi.fn(async () => ok({})),
    logout: vi.fn(async ({ accountId }: { accountId: string }) => {
      accounts = accounts.filter(account => account.id !== accountId)
      return ok({})
    }),
    usage: vi.fn(async () => ok({})),
  }
  const onBusy = vi.fn()
  const openExternal = vi.fn(async () => undefined)
  Object.assign(globalThis, { hydraDesktop: { openExternal } })
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']}
    t={t} disabled={false} onBusy={onBusy} />)
  await screen.findByText('alice@example.test')
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  const input = await screen.findByLabelText<HTMLInputElement>('Authorization code')
  expect(input.type).toBe('password')
  const link = screen.getByRole('link', { name: en.accountOpenBrowser })
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  fireEvent.click(link)
  expect(openExternal).toHaveBeenCalledWith('https://example.test/login')
  fireEvent.change(input, { target: { value: 'one-use-code' } })
  fireEvent.click(screen.getByRole('button', { name: en.accountContinue }))
  await screen.findByText(en.accountAdded, {}, { timeout: 2000 })
  expect(screen.getByText('alice@example.test')).toBeDefined()
  expect(screen.getByText('bob@example.test')).toBeDefined()
  expect(screen.queryByDisplayValue('one-use-code')).toBeNull()
  expect(api.answer).toHaveBeenCalledWith({ attemptId: 'login', promptId: 'code', value: 'one-use-code' })
  fireEvent.click(screen.getByRole('button', { name: 'Sign out alice@example.test' }))
  await waitFor(() => { expect(screen.queryByText('alice@example.test')).toBeNull() })
  expect(screen.getByText('bob@example.test')).toBeDefined()
  expect(api.logout).toHaveBeenCalledWith({ key: flowKey, accountId: 'alice' })
  expect(onBusy).toHaveBeenLastCalledWith(false)
  delete (globalThis as typeof globalThis & { hydraDesktop?: unknown }).hydraDesktop
})

it('cancels a login whose begin response arrives after the editor closes', async () => {
  let finishBegin!: (value: RpcResponse<{ attemptId: string }>) => void
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [] }] }),
    begin: vi.fn(() => new Promise<RpcResponse<{ attemptId: string }>>((resolve) => { finishBegin = resolve })),
    cancel: vi.fn(async () => { throw new Error('connection closed') }),
    usage: vi.fn(async () => ok({})),
  }
  const view = render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']}
    t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText(en.accountsEmpty)
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  view.unmount()
  finishBegin(ok({ attemptId: 'late' }))
  await waitFor(() => { expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'late' }) })
})

it('shows provider-reported windows and banked resets per account', async () => {
  const usage = vi.fn(async () => ok({ usage: {
    planType: 'plus', limits: [
      { name: 'Codex', windowMinutes: 300, usedPercent: 25, resetsAt: 1_800_000_000 },
      { name: 'Codex', windowMinutes: 10_080, usedPercent: 50, resetsAt: 1_800_500_000 },
    ], bankedResetCount: 2, fetchedAt: 1_700_000_000,
  } }))
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'alice', label: 'alice@example.test' }] }] }),
    usage,
  }
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText('5 hour usage limit')
  expect(screen.getByText('75% left')).toBeDefined()
  expect(screen.getByText('Weekly usage limit')).toBeDefined()
  expect(screen.getByText('50% left')).toBeDefined()
  expect(screen.getByText(/Banked resets: 2/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: en.accountUsageRefresh.replace('{account}', 'alice@example.test') }))
  await waitFor(() => { expect(usage).toHaveBeenCalledTimes(2) })
})

it('renders an unnamed plan, an unwindowed limit, and unavailable banked resets', async () => {
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'alice', label: 'alice@example.test' }] }] }),
    usage: async () => ok({ usage: { limits: [{ name: 'Messages', usedPercent: 12.4 }, { name: 'Search', windowMinutes: 300, usedPercent: 5 }], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText('Messages')
  expect(screen.getByText('Messages')).toBeTruthy()
  expect(screen.getByText('88% left')).toBeTruthy()
  expect(screen.getByText('Search · 5 hour usage limit')).toBeTruthy()
  expect(screen.getByText('95% left')).toBeTruthy()
  expect(screen.getByText(en.accountBankedResetsUnavailable)).toBeTruthy()
})

it('groups Google model quota into the shared usage cards', async () => {
  const googleKey = 'llm-account-auth/antigravity'
  const api = {
    list: async () => ok({ entries: [{ key: googleKey, label: 'Google Antigravity', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'google', label: 'google@example.test' }] }] }),
    usage: async () => ok({ usage: { planType: 'Google AI Pro', limits: [
      { name: 'Gemini 3.1 Flash', group: 'Gemini models', window: 'weekly', windowMinutes: 10_080,
        usedPercent: 18, remainingAmount: 820, resetsAt: 1_800_000_000 },
      { name: 'Claude Opus', group: 'Claude and GPT models', window: '5 hours', windowMinutes: 300,
        usedPercent: 40, resetsAt: 1_800_000_000 },
      { name: 'Search', window: '5h', windowMinutes: 300, usedPercent: 20 },
      { name: 'Other model', usedPercent: 60 },
      { name: 'Disabled model', group: 'Other models', usedPercent: 0, disabled: true },
    ], credits: [
      { tier: 'g1', creditType: 'GOOGLE_ONE_AI', creditAmount: 1200, minimumCreditAmountForUsage: 100 },
      { tier: 'free', creditAmount: 4 },
      { tier: 'bonus' },
    ], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={googleKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  expect(await screen.findByText(en.accountUsageGeminiModels)).toBeTruthy()
  expect(screen.getByText(en.accountUsageClaudeGptModels)).toBeTruthy()
  expect(screen.getByText(en.accountUsageOtherModels)).toBeTruthy()
  expect(screen.getByText('82% left')).toBeTruthy()
  expect(screen.getByText('60% left')).toBeTruthy()
  expect(screen.getByText('Search · 5 hour usage limit')).toBeTruthy()
  expect(screen.getByText('Weekly usage limit')).toBeTruthy()
  expect(screen.getByText('820 remaining')).toBeTruthy()
  expect(screen.getByText('GOOGLE_ONE_AI: 1,200 credits')).toBeTruthy()
  expect(screen.getByText('free: 4 credits')).toBeTruthy()
  expect(screen.getByText(en.accountUsageUnavailable)).toBeTruthy()
  expect(screen.getByText('Credit use starts at 100')).toBeTruthy()
  expect(screen.getByText('Disabled')).toBeTruthy()
  expect(screen.getAllByRole('progressbar')).toHaveLength(4)
  expect(screen.queryByText(/Banked resets/)).toBeNull()
})

it('renders an empty Google credits section without a placeholder', async () => {
  const googleKey = 'llm-account-auth/antigravity'
  const api = {
    list: async () => ok({ entries: [{ key: googleKey, label: 'Google Antigravity', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'google', label: 'google@example.test' }] }] }),
    usage: async () => ok({ usage: { limits: [{ name: 'Gemini', usedPercent: 0 }], credits: [], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={googleKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText('Gemini')
  expect(screen.queryByRole('heading', { name: en.accountUsageCreditsTitle })).toBeNull()
})

it('keeps unknown providers on the generic usage presentation', async () => {
  const futureKey = 'llm-account-auth/future'
  const api = {
    list: async () => ok({ entries: [{ key: futureKey, label: 'Future', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [{ id: 'future', label: 'future@example.test' }] }] }),
    usage: async () => ok({ usage: { planType: 'Future plan', limits: [{ name: 'Messages', usedPercent: 10 }], fetchedAt: 1 } }),
  }
  render(<ProviderAccounts flowKey={futureKey} api={api as unknown as IApiClient['authorization']} t={t} disabled={false} onBusy={vi.fn()} />)
  expect(await screen.findByText('Messages')).toBeTruthy()
  expect(screen.getByText('90% left')).toBeTruthy()
})

it('requires a connected account for an active account-backed provider', () => {
  expect(providerAccountKey('llm-account-auth', 'chatgpt')).toBe(flowKey)
  expect(providerAccountKey('llm-account-auth', 'antigravity')).toBe('llm-account-auth/antigravity')
  expect(providerAccountKey('llm-pi-ai', 'openai')).toBeUndefined()
  const row = { entry: { active: true }, accountCount: 0 } as Parameters<typeof providerUsable>[0]
  expect(providerUsable(row)).toBe(false)
  expect(providerUsable({ ...row, accountCount: 2 })).toBe(true)
  expect(providerUsable({ ...row, entry: { ...row.entry, active: false }, accountCount: 2 })).toBe(false)
})

it.each(['chatgpt', 'future-provider'])('saves %s without requiring or storing an API key', async (provider) => {
  const config = Schema.object({ providers: Schema.dict(Schema.object({ models: Schema.array(Schema.object({ id: Schema.string() })) })) })
  const mutate = vi.fn(async () => ok({ revision: 2, user: { providers: { chatgpt: {} } } }))
  const set = vi.fn()
  const describe = vi.fn(async () => ok({ credentials: {} }))
  const onClose = vi.fn()
  render(<ProviderEditor provider={provider} displayName="ChatGPT" settingsPath={['providers', provider]}
    namespace={{ ns: 'llm-account-auth', schema: config.toJSON(), revision: 1, applies: 'live', secrets: [],
      value: { providers: {} }, base: {}, user: {} }} schema={settingsSchema} t={t} readOnly={false} onClose={onClose}
    api={{ settings: { mutate }, credentials: { describe, set },
      authorization: { list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
        inFlight: false, accounts: [] }] }), usage: async () => ok({}) } } as never} />)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  if (provider === 'chatgpt') {
    await screen.findByText(en.accountsEmpty)
    fireEvent.click(screen.getByText(en.customized))
    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'custom-model' } })
    expect(screen.getByDisplayValue('custom-model')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.resetModels }))
    expect(screen.queryByDisplayValue('custom-model')).toBeNull()
  } else expect(screen.queryByRole('button', { name: en.accountAdd })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(mutate).toHaveBeenCalledWith({ ns: 'llm-account-auth', expectedRevision: 1,
    ops: [{ op: 'set', path: ['providers', provider], value: {} }] })
  expect(set).not.toHaveBeenCalled()
  expect(describe).not.toHaveBeenCalled()
})
