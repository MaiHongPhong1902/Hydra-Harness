/** Test-only account-backed providers for the assembled authorization browser lane. */
import type { Context } from '@hydra/cordis'
import Schema from '@hydra/schemastery'
import { credentialKey } from '@hydra/harness-credentials'
import { authorizationAccountId } from '@hydra/harness-authorization'
import type {
  AuthorizationAccount,
  AuthorizationAccounts,
  AuthorizationFlow,
  AuthorizationUsage,
} from '@hydra/harness-authorization'
import { LlmAdapter } from '@hydra/harness-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@hydra/harness-llm'
import { settingsNamespace } from '@hydra/harness-settings'

/** Loader identity of the deterministic account-auth replacement plugin. */
export const name = 'llm-account-auth-fixture'

/** Services required by this fixture's registrations. */
export const inject = ['llm', 'settings', 'credentials', 'authorization']

/** Settings namespace used by the account-backed test providers. */
export const ACCOUNT_AUTH_NAMESPACE = settingsNamespace('llm-account-auth')

/** The deterministic model directory exposed by this fixture. */
export const ACCOUNT_AUTH_PROVIDERS = [
  { provider: 'chatgpt', displayName: 'ChatGPT', model: 'gpt-5-test', modelName: 'GPT-5 Test' },
  {
    provider: 'antigravity',
    displayName: 'Google Antigravity',
    model: 'gemini-2.5-test',
    modelName: 'Gemini 2.5 Test',
  },
] as const

const AccountAuthConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    models: Schema.array(Schema.object({ id: Schema.string() })),
  })),
})

type AccountEntry = AuthorizationAccount

function entriesFromRecord(record: unknown): AccountEntry[] {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return []
  const candidate = (record as { kind?: unknown; payload?: unknown })
  if (candidate.kind !== 'grant' || typeof candidate.payload !== 'object'
    || candidate.payload === null || Array.isArray(candidate.payload)) return []
  const accounts = (candidate.payload as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return []
  return accounts.flatMap((account): AccountEntry[] => {
    if (typeof account !== 'object' || account === null || Array.isArray(account)) return []
    const { id, label } = account as { id?: unknown; label?: unknown }
    return typeof id === 'string' && id.length > 0 && typeof label === 'string' && label.length > 0
      ? [{ id: authorizationAccountId(id), label }]
      : []
  })
}

function accountStore(ctx: Context, key: ReturnType<typeof credentialKey>): AuthorizationAccounts {
  return {
    async list(): Promise<readonly AccountEntry[]> {
      return entriesFromRecord(await ctx.credentials.readRecord(key))
    },
    async remove(id: string): Promise<void> {
      await ctx.credentials.modifyRecord(key, async (current) => {
        const accounts = entriesFromRecord(current).filter(account => account.id !== id)
        return { kind: 'grant', payload: { accounts } }
      })
    },
    async usage(): Promise<AuthorizationUsage> {
      return {
        planType: 'fixture',
        limits: [{ name: '5h', windowMinutes: 300, usedPercent: 25, resetsAt: 1_800_000_000 }],
        bankedResetCount: 1,
        fetchedAt: 1_800_000_000,
      }
    },
  }
}

/** Adapter metadata is real; a model stream is intentionally out of scope for this settings/auth test. */
class AccountAuthAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    const entry = ACCOUNT_AUTH_PROVIDERS.find(candidate => candidate.provider === provider)
    return { id: provider, name: entry?.displayName ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const entry = ACCOUNT_AUTH_PROVIDERS.find(candidate => candidate.provider === provider)
    return Promise.resolve(entry === undefined ? [] : [{
      provider,
      id: entry.model,
      name: entry.modelName,
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = ACCOUNT_AUTH_PROVIDERS.find(candidate => candidate.provider === provider)
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.model === model ? entry.modelName : model,
      context: { contextWindow: 128_000 },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('account auth browser fixture: model generation is not part of this test')
  }
}

function flowFor(ctx: Context, provider: (typeof ACCOUNT_AUTH_PROVIDERS)[number]): AuthorizationFlow {
  const key = credentialKey('llm-account-auth', provider.provider)
  return {
    key,
    label: provider.displayName,
    methods: [{ id: 'oauth', label: `Sign in with ${provider.displayName}` }],
    accounts: accountStore(ctx, key),
    async run(session) {
      // The browser sees a normal provider notice and a safe HTTPS link, but
      // the test never leaves the local process to perform OAuth.
      session.notify({
        message: `Continue signing in to ${provider.displayName} in your browser.`,
        url: `https://auth.example.test/${provider.provider}`,
      })
      await ctx.credentials.modifyRecord(key, async (current) => {
        const accounts = entriesFromRecord(current)
        const id = `${provider.provider}-${String(accounts.length + 1)}`
        const labels = provider.provider === 'chatgpt'
          ? ['alice@example.test', 'bob@example.test']
          : ['google@example.test']
        const label = labels[accounts.length] ?? `${provider.provider}-${String(accounts.length + 1)}@example.test`
        return { kind: 'grant', payload: { accounts: [...accounts, { id, label }] } }
      })
    },
  }
}

/** Mount the deterministic account-auth replacement through the fixture fiber. */
export function apply(ctx: Context): void {
  ctx.settings.register(ACCOUNT_AUTH_NAMESPACE, AccountAuthConfig, {
    base: {
      providers: {},
    },
  })
  ctx.llm.registerConfigurableProviders(ACCOUNT_AUTH_PROVIDERS.map(provider => ({
    provider: provider.provider,
    displayName: provider.displayName,
    settingsNs: ACCOUNT_AUTH_NAMESPACE,
    settingsPath: ['providers', provider.provider],
  })))
  ctx.llm.registerAdapter(ACCOUNT_AUTH_PROVIDERS.map(provider => provider.provider), new AccountAuthAdapter())
  for (const provider of ACCOUNT_AUTH_PROVIDERS) ctx.authorization.registerFlow(flowFor(ctx, provider))
}
