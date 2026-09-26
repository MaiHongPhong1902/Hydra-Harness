// @vitest-environment jsdom
/** Authorization failures and responses arriving after their editor closes. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AuthorizationAttemptView, IApiClient, RpcResponse } from '@hydra1902/harness-api-remotes/client'
import { ProviderAccounts } from '../src/client/ProviderAccounts.tsx'
import { en } from '../src/client/locales.ts'

type AuthorizationApi = IApiClient['authorization']
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'account-test' as never, result: { ok: true, value } })
const failure = { rpcId: 'account-test' as never, result: { ok: false as const, error: { code: 'internal' as const, message: 'unavailable', details: {} } } }
const entries = [{ key: 'llm-account-auth/chatgpt', label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false, accounts: [{ id: 'a', label: 'Alice' }] }]
const t = (key: keyof typeof en) => en[key]

function apiFixture() {
  return {
    list: vi.fn<AuthorizationApi['list']>().mockResolvedValue(ok({ entries })),
    begin: vi.fn<AuthorizationApi['begin']>().mockResolvedValue(ok({ attemptId: 'login' })),
    state: vi.fn<AuthorizationApi['state']>().mockResolvedValue(ok({ attempt: { id: 'login', status: 'running' } })),
    answer: vi.fn<AuthorizationApi['answer']>().mockResolvedValue(ok({})),
    cancel: vi.fn<AuthorizationApi['cancel']>().mockResolvedValue(ok({})),
    logout: vi.fn<AuthorizationApi['logout']>().mockResolvedValue(ok({})),
    usage: vi.fn<AuthorizationApi['usage']>().mockResolvedValue(ok({})),
  }
}

function mount(api: AuthorizationApi) {
  const onBusy = vi.fn()
  return { ...render(<ProviderAccounts flowKey={entries[0]!.key} api={api} t={t} disabled={false} onBusy={onBusy} />), onBusy }
}

async function begin(): Promise<void> {
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: en.accountAdd }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['missing', 'business', 'transport'])('reports an unavailable authorization directory: %s', async (kind) => {
  const api = apiFixture()
  if (kind === 'missing') api.list.mockResolvedValue(ok({ entries: [] }))
  else if (kind === 'business') api.list.mockResolvedValue(failure)
  else api.list.mockRejectedValue('unavailable')
  mount(api)
  expect((await screen.findByRole('alert')).textContent).toBe(kind === 'missing' ? en.accountsUnavailable : 'unavailable')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.accountAdd }).disabled).toBe(true)
})

it.each([false, true])('ignores the initial account listing after unmount (reject: %s)', async (reject) => {
  const api = apiFixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<AuthorizationApi['list']>>>()
  api.list.mockReturnValue(pending.promise)
  mount(api).unmount()
  await act(async () => {
    if (reject) pending.reject(new Error('unavailable'))
    else pending.resolve(ok({ entries }))
  })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([false, true])('handles a rejected begin before or after unmount: %s', async (unmount) => {
  const api = apiFixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<AuthorizationApi['begin']>>>()
  api.begin.mockReturnValue(pending.promise)
  const view = mount(api)
  await begin()
  if (unmount) view.unmount()
  await act(async () => { pending.resolve(failure) })
  if (unmount) expect(screen.queryByRole('alert')).toBeNull()
  else expect(screen.getByRole('alert').textContent).toBe('unavailable')
  expect(view.onBusy).toHaveBeenLastCalledWith(false)
})

it.each(['state', 'directory', 'transport'])('cancels a login when polling fails: %s', async (kind) => {
  const api = apiFixture()
  api.cancel.mockRejectedValue(new Error('already closed'))
  if (kind === 'state') api.state.mockResolvedValue(failure)
  else if (kind === 'transport') api.state.mockRejectedValue(new Error('unavailable'))
  else {
    api.state.mockResolvedValue(ok({ attempt: { id: 'login', status: 'cancelled' } }))
    api.list.mockResolvedValueOnce(ok({ entries })).mockResolvedValue(failure)
  }
  const view = mount(api)
  await begin()
  expect((await screen.findByRole('alert')).textContent).toBe('unavailable')
  expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'login' })
  expect(view.onBusy).toHaveBeenLastCalledWith(false)
})

it.each(['state', 'state-error', 'directory'])('drops polling responses after unmount: %s', async (stage) => {
  const api = apiFixture()
  const state = Promise.withResolvers<Awaited<ReturnType<AuthorizationApi['state']>>>()
  const list = Promise.withResolvers<Awaited<ReturnType<AuthorizationApi['list']>>>()
  if (stage === 'directory') {
    api.state.mockResolvedValue(ok({ attempt: { id: 'login', status: 'cancelled' } }))
    api.list.mockResolvedValueOnce(ok({ entries })).mockReturnValue(list.promise)
  } else api.state.mockReturnValue(state.promise)
  api.cancel.mockRejectedValue(new Error('closed'))
  const view = mount(api)
  await begin()
  await waitFor(() => { expect(stage === 'directory' ? api.list : api.state).toHaveBeenCalledTimes(stage === 'directory' ? 2 : 1) })
  view.unmount()
  await act(async () => {
    if (stage === 'directory') list.resolve(ok({ entries }))
    else if (stage === 'state-error') state.reject(new Error('closed'))
    else state.resolve(ok({ attempt: { id: 'login', status: 'cancelled' } }))
  })
  expect(api.cancel).toHaveBeenCalledWith({ attemptId: 'login' })
})

it.each(['logout', 'directory', 'late', 'late-error'])('handles sign-out failures and editor closure: %s', async (stage) => {
  const api = apiFixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<AuthorizationApi['list']>>>()
  if (stage === 'logout') api.logout.mockResolvedValue(failure)
  else api.list.mockResolvedValueOnce(ok({ entries })).mockReturnValue(pending.promise)
  const view = mount(api)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: 'Sign out Alice' }))
  if (stage !== 'logout') {
    await waitFor(() => { expect(api.list).toHaveBeenCalledTimes(2) })
    if (stage.startsWith('late')) view.unmount()
    await act(async () => {
      if (stage === 'late-error') pending.reject('closed')
      else pending.resolve(stage === 'directory' ? failure : ok({ entries: [] }))
    })
  }
  if (!stage.startsWith('late')) expect((await screen.findByRole('alert')).textContent).toBe('unavailable')
})

it.each(['text', 'select', 'empty-select'] as const)('answers a %s prompt and shows cancellation', async (kind) => {
  const api = apiFixture()
  const attempt: AuthorizationAttemptView = {
    id: 'login', status: 'running', notice: { message: 'Sign in', url: kind === 'text' ? 'https://example.test' : 'javascript:alert(1)', code: 'ABCD' },
    prompt: { id: 'prompt', kind: kind === 'text' ? 'text' : 'select', message: 'Choose account',
      ...kind === 'select' ? { options: [{ id: 'a', label: 'Account A' }] } : {} },
  }
  api.state.mockResolvedValue(ok({ attempt }))
  api.answer.mockResolvedValue(failure)
  api.cancel.mockResolvedValueOnce(failure).mockImplementation(async () => {
    api.state.mockResolvedValue(ok({ attempt: { id: 'login', status: 'cancelled' } }))
    return ok({})
  })
  mount(api)
  await begin()
  const input = await screen.findByLabelText('Choose account')
  if (kind === 'text') expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.test')
  else expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByText('ABCD')).not.toBeNull()
  if (kind !== 'empty-select') {
    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.click(screen.getByRole('button', { name: en.accountContinue }))
    expect((await screen.findByRole('alert')).textContent).toBe('unavailable')
    expect(api.answer).toHaveBeenCalledWith({ attemptId: 'login', promptId: 'prompt', value: 'a' })
  }
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.accountCancel })) })
  expect(screen.getByRole('alert').textContent).toBe('unavailable')
  fireEvent.click(screen.getByRole('button', { name: en.accountCancel }))
  await screen.findByText(en.accountCancelled)
})

it('reports a desktop browser-launch rejection and the terminal login error', async () => {
  const api = apiFixture()
  const openExternal = vi.fn().mockRejectedValue(new Error('browser unavailable'))
  vi.stubGlobal('hydraDesktop', { openExternal })
  api.state.mockResolvedValue(ok({ attempt: { id: 'login', status: 'running', notice: { message: 'Continue', url: 'https://example.test' } } }))
  mount(api)
  await begin()
  fireEvent.click(await screen.findByRole('link'))
  expect((await screen.findByRole('alert')).textContent).toBe('browser unavailable')
  cleanup()
  api.state.mockResolvedValue(ok({ attempt: { id: 'login', status: 'failed', error: 'login rejected' } }))
  mount(api)
  await begin()
  expect((await screen.findByRole('alert')).textContent).toBe('login rejected')
})
