import { describe, expect, it } from 'vitest'
import { Context } from '@hydraharness/cordis'
import { authorizationAccountId } from '@hydraharness/harness-authorization'
import type {
  AuthorizationAccount,
  AuthorizationAccountId,
  AuthorizationEntry,
  AuthorizationOutcome,
  AuthorizationService,
  AuthorizationUsage,
} from '@hydraharness/harness-authorization'
import { credentialKey, type CredentialKey } from '@hydraharness/harness-credentials'
import type { ApiProxy, RpcRequest, RpcResponse } from '../src/api/index.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

const KEY = credentialKey('llm-account-auth', 'chatgpt')
const ATTEMPT = '00000000-0000-4000-8000-000000000001'
let nextRpc = 0

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`auth-${nextRpc++}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('expected a successful response')
  return response.result.value
}

function expectError<T>(response: RpcResponse<T>): { code: string; message: string } {
  expect(response.result.ok).toBe(false)
  if (response.result.ok) throw new Error('expected an error response')
  return response.result.error
}

function entry(key: CredentialKey = KEY): AuthorizationEntry {
  return {
    key,
    label: 'ChatGPT',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
  }
}

type MockAuthorization = Pick<AuthorizationService, 'list' | 'describe' | 'begin' | 'cancel' | 'listAccounts' | 'removeAccount' | 'getUsage'>

function install(ctx: Context, overrides: Partial<MockAuthorization> = {}): MockAuthorization {
  const service: MockAuthorization = {
    list: () => [entry()],
    describe: key => key === KEY ? entry() : undefined,
    begin: async () => ({ status: 'authorized' }),
    cancel: () => {},
    listAccounts: async (): Promise<readonly AuthorizationAccount[]> => [],
    removeAccount: async (): Promise<void> => {},
    getUsage: async (): Promise<AuthorizationUsage | undefined> => undefined,
    ...overrides,
  }
  ctx.provide('authorization', service)
  return service
}

function apiFor(ctx: Context): ApiProxy {
  ctx.provide('userQuestions', { registerProvider: () => () => {} } as never)
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
}

async function waitForState(
  api: ApiProxy,
  attemptId: string,
  predicate: (status: Awaited<ReturnType<ApiProxy['authorization']['state']>>['result']) => boolean,
): Promise<Awaited<ReturnType<ApiProxy['authorization']['state']>>> {
  for (let i = 0; i < 100; i += 1) {
    const state = await api.authorization.state(request({ attemptId }))
    if (predicate(state.result)) return state
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('authorization state did not settle')
}

describe('authorization RPC bridge', () => {
  it('lists value-free provider accounts', async () => {
    const ctx = new Context()
    let listedKey: CredentialKey | undefined
    install(ctx, {
      listAccounts: async (key) => {
        listedKey = key
        return [{ id: authorizationAccountId('account-1'), label: 'user@example.com' }]
      },
    })

    const value = expectOk(await apiFor(ctx).authorization.list(request({})))
    expect(listedKey).toBe(KEY)
    expect(value).toEqual({
      entries: [{
        key: String(KEY),
        label: 'ChatGPT',
        methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
        inFlight: false,
        accounts: [{ id: 'account-1', label: 'user@example.com' }],
      }],
    })
    expect(JSON.stringify(value)).not.toContain('token')
  })

  it('returns provider usage for the selected account', async () => {
    const ctx = new Context()
    let selected: AuthorizationAccountId | undefined
    install(ctx, {
      listAccounts: async () => [{ id: authorizationAccountId('account-1'), label: 'user@example.com' }],
      getUsage: async (_key, accountId) => {
        selected = accountId
        return { planType: 'plus', limits: [
          { name: '5h', windowMinutes: 300, usedPercent: 25, resetsAt: 1_800_000_000 },
          { name: 'weekly', windowMinutes: 10_080, usedPercent: 50, resetsAt: 1_800_500_000 },
        ], bankedResetCount: 2, fetchedAt: 1_700_000_000 }
      },
    })
    const value = expectOk(await apiFor(ctx).authorization.usage(request({ key: String(KEY), accountId: 'account-1' })))
    expect(selected).toBe('account-1')
    expect(value.usage?.bankedResetCount).toBe(2)
    expect(value.usage?.limits.map(limit => limit.name)).toEqual(['5h', 'weekly'])
  })

  it('bridges notices, prompts, select validation, and terminal state', async () => {
    const ctx = new Context()
    let answer: string | undefined
    install(ctx, {
      begin: async ({ interaction }) => {
        interaction.notify({ message: 'Choose an account', url: 'https://accounts.example.test/start', code: 'ABC123' })
        interaction.notify({ message: 'Waiting for the browser callback' })
        answer = await interaction.prompt({
          kind: 'select',
          message: 'Account',
          options: [{ id: 'account-1', label: 'user@example.com' }],
        })
        return { status: 'authorized' }
      },
    })
    const api = apiFor(ctx)
    const started = expectOk(await api.authorization.begin(request({ key: String(KEY), method: 'oauth' })))
    const pending = await waitForState(api, started.attemptId, result =>
      result.ok && result.value.attempt.prompt !== undefined)
    if (!pending.result.ok || pending.result.value.attempt.prompt === undefined) throw new Error('prompt missing')
    const prompt = pending.result.value.attempt.prompt
    expect(pending.result.value.attempt.notice).toEqual({
      message: 'Waiting for the browser callback',
      url: 'https://accounts.example.test/start',
      code: 'ABC123',
    })

    const invalid = await api.authorization.answer(request({ attemptId: started.attemptId, promptId: prompt.id, value: 'forged-account' }))
    expect(expectError(invalid).message).toBe('authorization answer is invalid')

    const wrongPrompt = await api.authorization.answer(request({ attemptId: started.attemptId, promptId: ATTEMPT, value: 'account-1' }))
    expect(expectError(wrongPrompt).message).toBe('authorization prompt is unavailable')

    expectOk(await api.authorization.answer(request({ attemptId: started.attemptId, promptId: prompt.id, value: 'account-1' })))
    expect(answer).toBe('account-1')
    const finished = await waitForState(api, started.attemptId, result =>
      result.ok && result.value.attempt.status === 'authorized')
    expectOk(finished)
  })

  it('cancels a running attempt and rejects forged ids', async () => {
    const ctx = new Context()
    let finish: ((outcome: AuthorizationOutcome) => void) | undefined
    let cancelledKey: CredentialKey | undefined
    install(ctx, {
      begin: () => new Promise((resolve) => { finish = resolve }),
      cancel: (key) => {
        cancelledKey = key
      },
    })
    const api = apiFor(ctx)
    const started = expectOk(await api.authorization.begin(request({ key: String(KEY) })))
    expectOk(await api.authorization.cancel(request({ attemptId: started.attemptId })))
    expect(cancelledKey).toBe(KEY)
    const immediate = await api.authorization.state(request({ attemptId: started.attemptId }))
    expect(expectOk(immediate).attempt.status).toBe('cancelled')

    // The provider can finish after the surface has already cancelled its
    // attempt. The terminal local state must remain the user's cancellation.
    finish?.({ status: 'authorized' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const finished = await waitForState(api, started.attemptId, result =>
      result.ok && result.value.attempt.status === 'cancelled')
    expectOk(finished)

    const forged = await api.authorization.state(request({ attemptId: ATTEMPT }))
    expect(expectError(forged).message).toBe('authorization attempt is unavailable')
  })

  it('cancels a begin whose carrier aborts before the attempt id is handed over', async () => {
    const ctx = new Context()
    const controller = new AbortController()
    let serviceSignal: AbortSignal | undefined
    install(ctx, {
      begin: async ({ signal }) => {
        if (signal === undefined) throw new Error('authorization signal missing')
        serviceSignal = signal
        const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        controller.abort()
        await aborted
        return { status: 'cancelled' }
      },
    })
    const api = apiFor(ctx)
    const started = api.authorization.begin(request({ key: String(KEY) }), controller.signal)

    const response = await started
    expect(expectError(response).code).toBe('cancelled')
    expect(serviceSignal?.aborted).toBe(true)
  })

  it('drops non-http notice links before exposing them to the browser', async () => {
    const ctx = new Context()
    install(ctx, {
      begin: async ({ interaction }) => {
        interaction.notify({ message: 'Continue signing in', url: 'javascript:alert(1)', code: 'ABC123' })
        return { status: 'authorized' }
      },
    })
    const api = apiFor(ctx)
    const started = expectOk(await api.authorization.begin(request({ key: String(KEY) })))
    const finished = await waitForState(api, started.attemptId, result =>
      result.ok && result.value.attempt.status === 'authorized')
    if (!finished.result.ok) throw new Error('expected completed state')
    expect(finished.result.value.attempt.notice).toEqual({ message: 'Continue signing in', code: 'ABC123' })
  })

  it('bounds retained terminal attempt state', async () => {
    const ctx = new Context()
    install(ctx)
    const api = apiFor(ctx)
    const attemptIds: string[] = []
    for (let index = 0; index < 129; index += 1) {
      const started = expectOk(await api.authorization.begin(request({ key: String(KEY) })))
      attemptIds.push(started.attemptId)
      await waitForState(api, started.attemptId, result =>
        result.ok && result.value.attempt.status === 'authorized')
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const oldest = await api.authorization.state(request({ attemptId: attemptIds[0] as string }))
    expect(expectError(oldest).message).toBe('authorization attempt is unavailable')
    const newest = await api.authorization.state(request({ attemptId: attemptIds.at(-1) as string }))
    expect(expectOk(newest).attempt.status).toBe('authorized')
  })

  it('cancels and forgets a pending attempt when the gateway fiber is disposed', async () => {
    const ctx = new Context()
    let finish: ((outcome: AuthorizationOutcome) => void) | undefined
    let cancelled = false
    install(ctx, {
      begin: () => new Promise((resolve) => { finish = resolve }),
      cancel: (key) => {
        cancelled = key === KEY
        finish?.({ status: 'cancelled' })
      },
    })
    let api!: ApiProxy
    const fiber = await ctx.plugin({
      apply: (fiberCtx: Context) => { api = apiFor(fiberCtx) },
    })
    const started = expectOk(await api.authorization.begin(request({ key: String(KEY) })))

    await fiber.dispose()

    expect(cancelled).toBe(true)
    const state = await api.authorization.state(request({ attemptId: started.attemptId }))
    expect(expectError(state).message).toBe('authorization attempt is unavailable')
  })

  it('hides provider errors and delegates account logout', async () => {
    const ctx = new Context()
    let removed: { key: CredentialKey; accountId: AuthorizationAccountId } | undefined
    install(ctx, {
      begin: async () => { throw new Error('token=super-secret local=C:\\private') },
      removeAccount: async (key, accountId) => { removed = { key, accountId } },
    })
    const api = apiFor(ctx)
    const started = expectOk(await api.authorization.begin(request({ key: String(KEY) })))
    const failed = await waitForState(api, started.attemptId, result =>
      result.ok && result.value.attempt.status === 'failed')
    if (!failed.result.ok) throw new Error('expected failed state')
    expect(failed.result.value.attempt.error).toBe('authorization failed')
    expect(JSON.stringify(failed.result.value)).not.toContain('super-secret')

    expectOk(await api.authorization.logout(request({ key: String(KEY), accountId: 'account-1' })))
    expect(removed).toEqual({ key: KEY, accountId: 'account-1' })
  })
})
