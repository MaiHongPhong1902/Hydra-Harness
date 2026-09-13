/** ChatGPT OAuth bridging against the SDK provider and the durable account store. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@hydra/cordis'
import Credentials from '@hydra/harness-credentials-local'
import type { AuthorizationPrompt, AuthorizationSession } from '@hydra/harness-authorization'
import type { AuthInteraction, OAuthCredential } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { accountRecordKey, createAccountPool } from '../src/accounts.ts'
import { buildChatGptProfile, loginChatGpt } from '../src/chatgpt.ts'

const oauth = vi.hoisted(() => ({ login: vi.fn() }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', async (load) => {
  const original = await load<typeof import('@earendil-works/pi-ai/providers/openai-codex')>()
  return {
    ...original,
    openaiCodexProvider: () => {
      const provider = original.openaiCodexProvider()
      return { ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth, login: oauth.login } } }
    },
  }
})

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  oauth.login.mockReset()
})

async function poolFixture() {
  root = await mkdtemp(join(tmpdir(), 'hydra-chatgpt-login-'))
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Credentials, { path: join(root, '.credentials.yaml'), debounceMs: 10 })
  return createAccountPool({ ctx, key: accountRecordKey('chatgpt'), providerId: 'chatgpt', providerLabel: 'ChatGPT' })
}

const grant: OAuthCredential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 123456 }

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

it('projects the SDK catalog onto the ChatGPT route', async () => {
  const profile = await buildChatGptProfile({})
  const models = profile.piProvider.getModels()
  expect(models.length).toBeGreaterThan(0)
  expect(models.every(model => model.provider === 'chatgpt' && model.api === 'openai-codex-responses')).toBe(true)
  const model = models[0]!
  const custom = await buildChatGptProfile({ models: [{ id: model.id, name: 'My model', maxTokens: 2048 }] })
  expect(custom.piProvider.getModels()).toMatchObject([{ id: model.id, name: 'My model', maxTokens: 2048 }])
})

it('masks the manual code prompt and stores the returned OAuth grant', async () => {
  const pool = await poolFixture()
  const prompt = vi.fn(async (_request: AuthorizationPrompt) => 'test-code')
  const session: AuthorizationSession = {
    method: 'oauth', signal: new AbortController().signal,
    notify: vi.fn(),
    prompt,
  }
  oauth.login.mockImplementation(async (interaction: AuthInteraction) => {
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/test' })
    await interaction.prompt({ type: 'manual_code', message: 'Paste the callback' })
    return { ...grant, email: 'chatgpt@example.test' }
  })
  await loginChatGpt(session, pool)
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ kind: 'secret', message: 'Paste the callback' }))
  expect(await pool.accounts.list()).toMatchObject([{ label: 'chatgpt@example.test' }])
})

it('uses the ChatGPT profile claim for the automatic account label', async () => {
  const pool = await poolFixture()
  const session: AuthorizationSession = {
    method: 'oauth', signal: new AbortController().signal,
    notify: vi.fn(), prompt: async () => 'test-code',
  }
  oauth.login.mockResolvedValue({
    ...grant,
    access: fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-id' },
      'https://api.openai.com/profile': { email: 'profile@example.test' },
    }),
    accountId: 'workspace-id',
  })
  await loginChatGpt(session, pool)
  expect(await pool.accounts.list()).toMatchObject([{ label: 'profile@example.test' }])
})

it('rejects a late SDK login result after cancellation without storing an account', async () => {
  const pool = await poolFixture()
  const controller = new AbortController()
  const pending = Promise.withResolvers<OAuthCredential>()
  oauth.login.mockReturnValue(pending.promise)
  const login = loginChatGpt({
    method: 'oauth', signal: controller.signal,
    notify: () => undefined, prompt: async () => 'Cancelled',
  }, pool)
  const rejected = expect(login).rejects.toMatchObject({ code: 'ABORTED' })
  await vi.waitFor(() => { expect(oauth.login).toHaveBeenCalledOnce() })
  controller.abort()
  pending.resolve(grant)
  await rejected
  expect(await pool.accounts.list()).toEqual([])
})

it('serializes logout after an active refresh and prevents a stale refresh from restoring it', async () => {
  const pool = await poolFixture()
  const first = await pool.add('First', grant)
  const sibling = await pool.add('Sibling', { ...grant, access: 'sibling-access' })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const refresh = pool.withAccount(first.id, () => pool.credentials.modify('chatgpt', async (current) => {
    entered.resolve(undefined)
    await release.promise
    expect(current).toMatchObject({ access: 'test-access' })
    return { ...grant, access: 'refreshed-access' }
  }))
  await entered.promise
  const logout = pool.accounts.remove(first.id)
  release.resolve(undefined)
  await Promise.all([refresh, logout])
  expect(await pool.accounts.list()).toEqual([sibling])
  await expect(pool.withAccount(first.id, () => pool.credentials.modify('chatgpt', async () => grant)))
    .rejects.toMatchObject({ code: 'ACCOUNT_GONE' })
  await pool.withAccount(sibling.id, async () => {
    expect(await pool.credentials.read('chatgpt')).toMatchObject({ access: 'sibling-access' })
  })
})
