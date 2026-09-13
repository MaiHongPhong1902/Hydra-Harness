// @vitest-environment jsdom
/** Multiple account login, prompt privacy, and editor-owned cancellation. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IApiClient, RpcResponse } from '@hydra/harness-api-remotes/client'
import Schema from '@hydra/schemastery'
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
  }
  const onBusy = vi.fn()
  render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']}
    t={t} disabled={false} onBusy={onBusy} />)
  await screen.findByText('alice@example.test')
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  const input = await screen.findByLabelText<HTMLInputElement>('Authorization code')
  expect(input.type).toBe('password')
  expect(screen.getByRole('link', { name: en.accountOpenBrowser }).getAttribute('rel')).toBe('noopener noreferrer')
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
})

it('cancels a login whose begin response arrives after the editor closes', async () => {
  let finishBegin!: (value: RpcResponse<{ attemptId: string }>) => void
  const api = {
    list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false, accounts: [] }] }),
    begin: vi.fn(() => new Promise<RpcResponse<{ attemptId: string }>>((resolve) => { finishBegin = resolve })),
    cancel: vi.fn(async () => ok({})),
  }
  const view = render(<ProviderAccounts flowKey={flowKey} api={api as unknown as IApiClient['authorization']}
    t={t} disabled={false} onBusy={vi.fn()} />)
  await screen.findByText(en.accountsEmpty)
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
  view.unmount()
  finishBegin(ok({ attemptId: 'late' }))
  await waitFor(() => { expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'late' }) })
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

it('saves an account provider without requiring or storing an API key', async () => {
  const config = Schema.object({ providers: Schema.dict(Schema.object({ models: Schema.array(Schema.object({ id: Schema.string() })) })) })
  const mutate = vi.fn(async () => ok({ revision: 2, user: { providers: { chatgpt: {} } } }))
  const set = vi.fn()
  const describe = vi.fn(async () => ok({ credentials: {} }))
  const onClose = vi.fn()
  render(<ProviderEditor provider="chatgpt" displayName="ChatGPT" settingsPath={['providers', 'chatgpt']}
    namespace={{ ns: 'llm-account-auth', schema: config.toJSON(), revision: 1, applies: 'live', secrets: [],
      value: { providers: {} }, base: {}, user: {} }} schema={settingsSchema} t={t} readOnly={false} onClose={onClose}
    api={{ settings: { mutate }, credentials: { describe, set },
      authorization: { list: async () => ok({ entries: [{ key: flowKey, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }],
        inFlight: false, accounts: [] }] }) } } as never} />)
  await screen.findByText(en.accountsEmpty)
  expect(screen.queryByLabelText(en.keyInput)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(mutate).toHaveBeenCalledWith({ ns: 'llm-account-auth', expectedRevision: 1,
    ops: [{ op: 'set', path: ['providers', 'chatgpt'], value: {} }] })
  expect(set).not.toHaveBeenCalled()
  expect(describe).not.toHaveBeenCalled()
})
