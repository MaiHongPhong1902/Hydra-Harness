/** Native account routes; provider SDKs load only for login or model operations. */
import type { Context } from '@hydraharness/cordis'
import { installSettingsSection, settingsNamespace } from '@hydraharness/harness-settings'
import {
  LlmAdapter, LlmError,
  type AdapterRegistrationHandle, type GenerateOptions, type LlmDiscoveredModel,
  type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk,
} from '@hydraharness/harness-llm'
import { accountRecordKey, createAccountPool, type AccountPool } from './accounts.ts'
import {
  ACCOUNT_PROVIDER_LABELS, ACCOUNT_PROVIDERS, Config, resolveProfiles,
  type AccountProvider, type AccountProviderProfile,
} from './config.ts'

export const name = 'llm-account-auth'
export const inject = ['llm']
export { Config } from './config.ts'
export type { AccountModelProfile, AccountProviderProfile } from './config.ts'

const NS = settingsNamespace(name)
const emptyProfile: AccountProviderProfile = {}
type AccountRuntime = import('./adapter.ts').ChatGptAccountAdapter | import('./adapter.ts').AntigravityAccountAdapter

/** One lazy delegate per settings snapshot; active requests retain their own delegate. */
class AccountAdapter extends LlmAdapter {
  private previous: AccountProviderProfile | undefined
  private pending: Promise<AccountRuntime> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly provider: AccountProvider,
    private readonly pool: AccountPool,
    private readonly profile: () => AccountProviderProfile,
  ) { super() }

  invalidate(): void { this.pending = undefined }

  private load(): Promise<AccountRuntime> {
    const profile = this.profile()
    if (profile === this.previous && this.pending !== undefined) return this.pending
    this.previous = profile
    const pending = this.create(profile)
    this.pending = pending
    void pending.catch(() => {
      if (this.pending === pending) this.pending = undefined
    })
    return pending
  }

  private async create(profile: AccountProviderProfile): Promise<AccountRuntime> {
    const runtime = await import('./adapter.ts')
    const common = { pool: this.pool, resolveAttachments: () => this.ctx.get('attachments') }
    if (this.provider === 'antigravity') {
      return new runtime.AntigravityAccountAdapter({ ...common, profile: () => profile })
    }
    const { buildChatGptProfile } = await import('./chatgpt.ts')
    const resolved = await buildChatGptProfile(profile)
    return new runtime.ChatGptAccountAdapter({ ...common, profile: () => resolved })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: ACCOUNT_PROVIDER_LABELS[this.provider] }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.load()).listModels(provider)
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return (await this.load()).resolveModel(provider, model, signal)
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    options.signal?.throwIfAborted()
    const delegate = await this.load()
    options.signal?.throwIfAborted()
    yield* delegate.stream(options)
  }

  async discover(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    signal?.throwIfAborted()
    const delegate = await this.load()
    return delegate.discoverModels(signal)
  }
}

/**
 * Offer account login and configure live routes without starting provider work.
 * @param ctx - plugin context owning all registrations.
 * @param config - base account-provider settings.
 */
export function apply(ctx: Context, config: Config): void {
  let source = (): Config => config
  let previous: Config | undefined
  let resolved: ReadonlyMap<AccountProvider, AccountProviderProfile> = new Map()
  const profiles = (): ReadonlyMap<AccountProvider, AccountProviderProfile> => {
    const raw = source()
    if (raw !== previous) {
      resolved = resolveProfiles(raw.providers)
      previous = raw
    }
    return resolved
  }
  profiles()

  const routes = ACCOUNT_PROVIDERS.map((provider) => {
    const key = accountRecordKey(provider)
    const pool = createAccountPool({ ctx, key, providerId: provider, providerLabel: ACCOUNT_PROVIDER_LABELS[provider] })
    return {
      provider, key, pool,
      adapter: new AccountAdapter(ctx, provider, pool, () => profiles().get(provider) ?? emptyProfile),
      registration: undefined as AdapterRegistrationHandle | undefined,
    }
  })

  ctx.llm.registerConfigurableProviders(routes.map(({ provider }) => ({
    provider, displayName: ACCOUNT_PROVIDER_LABELS[provider], settingsNs: NS,
    settingsPath: ['providers', provider],
  })))
  ctx.llm.registerModelDiscovery(NS, async (request) => {
    const route = routes.find(candidate => candidate.provider === request.provider)
    if (route === undefined) throw new LlmError('Select ChatGPT or Google Antigravity to discover models', 'INVALID_DISCOVERY')
    return route.adapter.discover(request.signal)
  })

  ctx.inject(['authorization'], (authorized) => {
    for (const { provider, key, pool } of routes) {
      authorized.authorization.registerFlow({
        key, label: ACCOUNT_PROVIDER_LABELS[provider],
        accounts: {
          ...pool.accounts,
          async usage(id, signal) {
            const { readAccountUsage } = await import('./usage.ts')
            return readAccountUsage(pool, id, provider, profiles().get(provider) ?? emptyProfile,
              /* v8 ignore next -- Config supplies usageTimeoutMs through its schema default. */
              source().usageTimeoutMs ?? 15_000, signal)
          },
        },
        methods: [{ id: 'oauth', label: 'Sign in with ' + ACCOUNT_PROVIDER_LABELS[provider] }],
        async run(session) {
          if (provider === 'chatgpt') {
            const { loginChatGpt } = await import('./chatgpt.ts')
            await loginChatGpt(session, pool)
            return
          }
          const { loginAntigravity } = await import('./antigravity-oauth.ts')
          const profile = profiles().get(provider)
          const grant = await loginAntigravity(session, {
            ...profile?.callbackPort === undefined ? {} : { callbackPort: profile.callbackPort },
            ...profile?.callbackPath === undefined ? {} : { callbackPath: profile.callbackPath },
            ...profile?.onboardingAttempts === undefined ? {} : { onboardingAttempts: profile.onboardingAttempts },
            ...profile?.onboardingDelayMs === undefined ? {} : { onboardingDelayMs: profile.onboardingDelayMs },
          })
          await pool.add(undefined, { type: 'oauth', ...grant }, session.signal)
        },
      })
    }
  })

  const register = (): void => {
    for (const route of routes) {
      const enabled = profiles().has(route.provider)
      if (route.registration !== undefined) route.registration.replace(enabled ? [route.provider] : [])
      else if (enabled) route.registration = ctx.llm.registerAdapter([route.provider], route.adapter)
    }
  }
  register()
  ctx.on('credentials/record-updated', (key) => {
    const route = routes.find(candidate => candidate.key === key)
    if (route === undefined) return
    route.adapter.invalidate()
    if (route.registration !== undefined && profiles().has(route.provider)) route.registration.replace([route.provider])
  })
  installSettingsSection(ctx, NS, Config, config, {
    validate: (value) => { resolveProfiles(value.providers) },
    setSource: (next) => { source = next },
    onChange: register,
  })
}
