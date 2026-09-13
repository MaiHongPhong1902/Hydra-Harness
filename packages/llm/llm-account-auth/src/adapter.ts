/** Account-aware LLM adapters for the native ChatGPT and Antigravity routes. */

import type { Credential } from '@earendil-works/pi-ai'
import type { AntigravityCredentials } from './antigravity-oauth.ts'
import { emptyAuthContext, type AccountPool } from './accounts.ts'
import type { AccountModelProfile, AccountProviderProfile, AccountProvider } from './config.ts'
import {
  deepFreeze,
  freezeMessage,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmDiscoveredModel,
  type LlmFailure,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@hydra/harness-llm'
import type { PiAiAdapter, ResolvedPiAiProviderProfile } from '@hydra/harness-llm-pi-ai'

/** A provider profile lookup that follows live settings changes. */
export type AccountProfileLookup = () => AccountProviderProfile | undefined

/** Inputs for the ChatGPT account adapter. */
export interface ChatGptAdapterOptions {
  /** Pool owning the selected account and pi-ai credential store. */
  pool: AccountPool
  /** Current resolved ChatGPT pi-ai profile. */
  profile: () => ResolvedPiAiProviderProfile | undefined
  /** Build the current profile on first model use. */
  loadProfile?: () => Promise<ResolvedPiAiProviderProfile | undefined>
  /** Resolve the optional durable attachment service. */
  resolveAttachments?: () => import('@hydra/harness-attachment').AttachmentStore | undefined
}

/** Inputs for the Antigravity account adapter. */
export interface AntigravityAdapterOptions {
  /** Pool owning the selected account. */
  pool: AccountPool
  /** Current settings profile. */
  profile: AccountProfileLookup
  /** Resolve the optional durable attachment service. */
  resolveAttachments?: () => import('@hydra/harness-attachment').AttachmentStore | undefined
}

function visible(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta'
    || chunk.type === 'reasoning-delta'
    || chunk.type === 'tool-call-delta'
}

function accountCredential(value: Credential | undefined): AntigravityCredentials | undefined {
  if (value?.type !== 'oauth') return undefined
  const candidate = value as Credential & Partial<AntigravityCredentials>
  if (typeof candidate.access !== 'string' || candidate.access.length === 0
    || typeof candidate.refresh !== 'string' || candidate.refresh.length === 0
    || typeof candidate.expires !== 'number' || !Number.isFinite(candidate.expires)
    || typeof candidate.projectId !== 'string' || candidate.projectId.length === 0) return undefined
  return {
    access: candidate.access,
    refresh: candidate.refresh,
    expires: candidate.expires,
    projectId: candidate.projectId,
    ...(typeof candidate.email === 'string' && candidate.email.length > 0 ? { email: candidate.email } : {}),
  }
}

function thrownCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { code?: unknown }).code
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LlmError('Model request canceled', 'ABORTED', { cause: signal.reason })
  }
}

function antigravityOAuthOptions(profile: AccountProviderProfile): {
  callbackPort?: number
  callbackPath?: string
  onboardingAttempts?: number
  onboardingDelayMs?: number
} {
  return {
    ...(profile.callbackPort === undefined ? {} : { callbackPort: profile.callbackPort }),
    ...(profile.callbackPath === undefined ? {} : { callbackPath: profile.callbackPath }),
    ...(profile.onboardingAttempts === undefined ? {} : { onboardingAttempts: profile.onboardingAttempts }),
    ...(profile.onboardingDelayMs === undefined ? {} : { onboardingDelayMs: profile.onboardingDelayMs }),
  }
}

function withoutAccountReplay(options: GenerateOptions): GenerateOptions {
  const messages = options.messages.map((message): Message => {
    const source = message.source
    if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
    return freezeMessage({
      ...message,
      source: { kind: 'model', provider: source.provider, model: source.model },
    })
  })
  if (messages.every((message, index) => message === options.messages[index])) return options
  const filtered = { ...options, messages }
  return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
}

/**
 * Run one account order and retry only failures seen before visible output.
 * The order is captured once for this adapter call, so every account is tried
 * at most once before the caller's normal request-recovery policy runs.
 */
async function* streamAccounts(
  options: GenerateOptions,
  provider: AccountProvider,
  pool: AccountPool,
  source: (accountId: string, options: GenerateOptions) => AsyncIterable<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  const order = await pool.selector.ordered(provider)
  if (order.length === 0) throw new LlmError(`${provider} has no connected account`, 'MISSING_CREDENTIAL')
  // Account rotation is request-local and the next request may select a
  // different identity. Provider replay ids and signatures belong to the
  // account that produced them, so never carry that opaque state into an
  // account-backed request.
  const accountOptions = withoutAccountReplay(options)
  let lastFailure: LlmFailure | undefined
  let lastThrown: unknown
  for (const entry of order) {
    const attemptOptions = accountOptions
    if (attemptOptions.signal?.aborted) throw new LlmError('Model request canceled', 'ABORTED', { cause: attemptOptions.signal.reason })
    let emitted = false
    let finished = false
    let retry = false
    const buffered: StreamChunk[] = []
    try {
      for await (const chunk of pool.selector.stream(provider, entry.id, () => source(entry.id, attemptOptions))) {
        attemptOptions.signal?.throwIfAborted()
        if (chunk.type === 'finish') {
          finished = true
          if (chunk.reason.kind === 'aborted') {
            for (const held of buffered) yield held
            yield chunk
            return
          }
          if (chunk.reason.kind === 'error' && !emitted) {
            lastFailure = chunk.reason.failure
            retry = true
            break
          }
        }
        if (!emitted && visible(chunk)) {
          emitted = true
          for (const held of buffered) yield held
          buffered.length = 0
        }
        if (emitted) yield chunk
        else buffered.push(chunk)
      }
    } catch (error: unknown) {
      if (attemptOptions.signal?.aborted || thrownCode(error) === 'ABORTED') throw error
      if (emitted) throw error
      // A later account's thrown failure is the final outcome. Do not let a
      // prior account's provider finish mask it with a synthetic finish.
      lastFailure = undefined
      lastThrown = error
      retry = true
    }
    if (retry) continue
    if (!finished) {
      if (emitted) throw new LlmError(`${provider} stream ended without a finish chunk`, 'STREAM_CLOSED')
      lastFailure = undefined
      lastThrown = new LlmError(`${provider} stream ended without a finish chunk`, 'STREAM_CLOSED')
      continue
    }
    for (const held of buffered) yield held
    return
  }
  if (lastFailure !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure: lastFailure } }
    return
  }
  if (lastThrown instanceof Error) throw lastThrown
  if (lastThrown !== undefined) {
    throw new LlmError(`${provider} account request failed`, 'TRANSPORT', { cause: lastThrown })
  }
  throw new LlmError(`${provider} account request failed`, 'TRANSPORT')
}

/** pi-ai adapter that binds every request to one native ChatGPT account. */
export class ChatGptAccountAdapter extends LlmAdapter {
  private delegatePromise: Promise<PiAiAdapter> | undefined
  private loadedProfile: ResolvedPiAiProviderProfile | undefined
  private profilePromise: Promise<ResolvedPiAiProviderProfile | undefined> | undefined

  constructor(private readonly config: ChatGptAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ChatGPT' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    const profile = this.config.profile() ?? this.loadedProfile
    return profile?.provider === provider ? profile.retryPolicy : undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const delegate = await this.ensureDelegate()
    return delegate.listModels(provider)
  }

  /**
   * Return the local ChatGPT catalog in the discovery seam's detached form.
   * @param signal - optional cancellation for catalog resolution.
   * @returns model metadata suitable for the LLM discovery seam.
   */
  async discoverModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    signal?.throwIfAborted()
    const delegate = await this.ensureDelegate()
    const models = await delegate.listModels('chatgpt')
    return Promise.all(models.map(async (model) => {
      signal?.throwIfAborted()
      const resolved = await delegate.resolveModel('chatgpt', model.id, signal)
      return {
        id: model.id,
        name: model.name,
        ...(resolved.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
        ...(resolved.defaultMaxTokens === undefined ? {} : { maxTokens: resolved.defaultMaxTokens }),
      }
    }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const delegate = await this.ensureDelegate()
    return delegate.resolveModel(provider, model, signal)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const delegate = await this.ensureDelegate()
    yield* streamAccounts(options, 'chatgpt', this.config.pool, (_accountId, attemptOptions) => delegate.stream(attemptOptions))
  }

  private async ensureProfile(): Promise<ResolvedPiAiProviderProfile> {
    const current = this.config.profile()
    if (current !== undefined) {
      this.loadedProfile = current
      return current
    }
    if (this.config.loadProfile === undefined) {
      throw new LlmError('ChatGPT account route has no profile', 'NO_ADAPTER')
    }
    this.profilePromise ??= this.config.loadProfile()
    const loaded = await this.profilePromise
    if (loaded === undefined) throw new LlmError('ChatGPT account route has no profile', 'NO_ADAPTER')
    this.loadedProfile = loaded
    return loaded
  }

  private async ensureDelegate(): Promise<PiAiAdapter> {
    await this.ensureProfile()
    this.delegatePromise ??= import('@hydra/harness-llm-pi-ai').then(({ PiAiAdapter }) => new PiAiAdapter({
      profiles: () => {
        const profile = this.config.profile() ?? this.loadedProfile
        return profile === undefined
          ? new Map<string, ResolvedPiAiProviderProfile>()
          : new Map([[profile.provider, profile]])
      },
      resolveApiKey: () => Promise.resolve(undefined),
      auth: { credentials: this.config.pool.credentials, authContext: emptyAuthContext },
      ...(this.config.resolveAttachments === undefined
        ? {}
        : { resolveAttachments: this.config.resolveAttachments }),
    }))
    return this.delegatePromise
  }
}

/** Direct native Antigravity adapter bound to the selected account pool. */
export class AntigravityAccountAdapter extends LlmAdapter {
  private nativeModulePromise: Promise<typeof import('./antigravity.ts')> | undefined
  private catalog?: {
    profile: AccountProviderProfile
    accountId: string
    models: readonly AntigravityCatalogModel[]
  }
  private catalogPromise?: {
    profile: AccountProviderProfile
    accountId: string
    promise: Promise<readonly AntigravityCatalogModel[]>
  } | undefined

  constructor(private readonly config: AntigravityAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Google Antigravity' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.models()
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.supportsImages === undefined
        ? {}
        : { inputModalities: model.supportsImages ? ['text', 'image'] as const : ['text'] as const }),
    }))
  }

  /**
   * Return the configured or account-authenticated Antigravity catalog.
   * @param signal - optional cancellation for account refresh and discovery.
   * @returns model metadata suitable for the LLM discovery seam.
   */
  async discoverModels(signal?: AbortSignal): Promise<LlmDiscoveredModel[]> {
    const models = await this.models(signal)
    signal?.throwIfAborted()
    return models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }))
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const known = (await this.models(signal)).find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.supportsImages === undefined
        ? {}
        : { inputModalities: known.supportsImages ? ['text', 'image'] as const : ['text'] as const }),
      ...(known?.contextWindow === undefined ? {} : { context: { contextWindow: known.contextWindow } }),
      ...(known?.maxTokens === undefined ? {} : { defaultMaxTokens: known.maxTokens }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const profile = this.config.profile()
    if (profile === undefined) throw new LlmError('Antigravity account route has no profile', 'NO_ADAPTER')
    yield* streamAccounts(options, 'antigravity', this.config.pool,
      (accountId, attemptOptions) => this.streamAccount(attemptOptions, profile, accountId))
  }

  private async *streamAccount(
    options: GenerateOptions,
    profile: AccountProviderProfile,
    accountId: string,
  ): AsyncIterable<StreamChunk> {
    const credentials = await this.selectedCredentials(accountId, profile, options.signal)
    const { AntigravityAdapter } = await this.nativeModule()
    const delegate = new AntigravityAdapter({
      resolveCredentials: () => Promise.resolve(credentials),
      ...(profile.models === undefined ? {} : { models: profile.models }),
      ...(profile.endpoint === undefined ? {} : { endpoint: profile.endpoint }),
      ...(this.config.resolveAttachments === undefined
        ? {}
        : { resolveAttachments: this.config.resolveAttachments }),
    })
    yield* delegate.stream(options)
  }

  private async models(
    signal?: AbortSignal,
  ): Promise<readonly AntigravityCatalogModel[]> {
    const profile = this.config.profile()
    if (profile === undefined) throw new LlmError('Antigravity account route has no profile', 'NO_ADAPTER')
    if (profile.models !== undefined) return profile.models
    const accounts = await this.config.pool.accounts.list()
    const account = accounts[0]
    if (account === undefined) return []
    if (this.catalog?.profile === profile && this.catalog.accountId === account.id) return this.catalog.models
    const pending = this.catalogPromise
    if (pending?.profile === profile && pending.accountId === account.id) return pending.promise
    const promise = this.discover(profile, account.id, signal)
    const pendingState = { profile, accountId: account.id, promise }
    this.catalogPromise = pendingState
    try {
      const models = await promise
      if (this.config.profile() === profile) this.catalog = { profile, accountId: account.id, models }
      return models
    } finally {
      if (this.catalogPromise === pendingState) this.catalogPromise = undefined
    }
  }

  private async discover(
    profile: AccountProviderProfile,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<readonly AntigravityCatalogModel[]> {
    const credentials = await this.selectedCredentials(accountId, profile, signal)
    const { discoverAntigravityModels } = await this.nativeModule()
    const models = await discoverAntigravityModels({
      accessToken: credentials.access,
      projectId: credentials.projectId,
      ...(signal === undefined ? {} : { signal }),
      ...(profile.endpoint === undefined ? {} : { endpoint: profile.endpoint }),
    })
    return models
      .filter(model => !model.internal)
      .map(model => ({
        id: model.id,
        name: model.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        supportsImages: model.supportsImages,
        supportsThinking: model.supportsThinking,
      }))
  }

  private async selectedCredentials(
    accountId: string,
    profile: AccountProviderProfile,
    signal?: AbortSignal,
  ): Promise<AntigravityCredentials> {
    const { refreshAntigravity } = await import('./antigravity-oauth.ts')
    return this.config.pool.withAccount(accountId, async () => {
      abortIfNeeded(signal)
      let selected: AntigravityCredentials | undefined
      await this.config.pool.credentials.modify('antigravity', async (current) => {
        abortIfNeeded(signal)
        const credentials = accountCredential(current)
        if (credentials === undefined) {
          throw new LlmError(`antigravity account "${accountId}" has invalid credentials`, 'INVALID_CREDENTIAL')
        }
        if (credentials.expires > Date.now()) {
          selected = credentials
          return undefined
        }
        const refreshed = await refreshAntigravity(credentials, antigravityOAuthOptions(profile), signal)
        abortIfNeeded(signal)
        selected = refreshed
        return { type: 'oauth', ...refreshed }
      })
      if (selected === undefined) {
        throw new LlmError(`antigravity account "${accountId}" has no credentials`, 'MISSING_CREDENTIAL')
      }
      return selected
    })
  }

  private async nativeModule(): Promise<typeof import('./antigravity.ts')> {
    this.nativeModulePromise ??= import('./antigravity.ts')
    return this.nativeModulePromise
  }
}

interface AntigravityCatalogModel extends AccountModelProfile {
  supportsImages?: boolean
  supportsThinking?: boolean
}
