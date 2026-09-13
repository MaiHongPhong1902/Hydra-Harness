/** Settings for the two native account-backed provider routes. */

import z from '@hydra/schemastery'
import { MAX_TIMER_DELAY_MS } from '@hydra/harness-timeout'

/** One optional model override for an account-backed route. */
export interface AccountModelProfile {
  /** Provider model id sent on requests. */
  id: string
  /** Selector label; defaults to the provider catalog's name. */
  name?: string
  /** Combined input and output context capacity. */
  contextWindow?: number
  /** Maximum output token capability. */
  maxTokens?: number
}

/** One account-backed provider's settings. */
export interface AccountProviderProfile {
  /** Optional replacement model catalog. */
  models?: AccountModelProfile[]
  /** Fallback context capacity for a model with no provider metadata. */
  defaultContextWindow?: number
  /** Fallback output capacity for a model with no provider metadata. */
  defaultMaxTokens?: number
  /** Maximum idle interval while one provider stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Maximum base64-encoded image payload accepted in one request. */
  maxRequestImageBytes?: number
  /** Optional Cloud Code Assist endpoint used by Antigravity requests. */
  endpoint?: string
  /** Loopback callback port used by Antigravity OAuth; zero asks the OS for a free port. */
  callbackPort?: number
  /** Loopback callback path used by Antigravity OAuth. */
  callbackPath?: string
  /** Number of Antigravity onboarding attempts. */
  onboardingAttempts?: number
  /** Delay between incomplete Antigravity onboarding attempts. */
  onboardingDelayMs?: number
}

/** Plugin settings, keyed by the route names `chatgpt` and `antigravity`. */
export interface Config {
  /** Enabled account-backed routes. An empty map leaves both routes dormant. */
  providers?: Record<string, AccountProviderProfile>
}

const modelProfile: z<AccountModelProfile> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const providerProfile: z<AccountProviderProfile> = z.object({
  models: z.array(modelProfile),
  defaultContextWindow: z.number().step(1).min(1),
  defaultMaxTokens: z.number().step(1).min(1),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS),
  maxRequestImageBytes: z.number().step(1).min(1),
  endpoint: z.string(),
  callbackPort: z.natural().max(65535),
  callbackPath: z.string(),
  onboardingAttempts: z.natural().min(1),
  onboardingDelayMs: z.number().step(1).min(0),
})

/** Schema used by the settings section and composition loader. */
export const Config: z<Config> = z.object({
  providers: z.dict(providerProfile).default({}),
})

/** The routes owned by this package, in UI and registration order. */
export const ACCOUNT_PROVIDERS = ['chatgpt', 'antigravity'] as const

/** Provider route type owned by this package. */
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]

/** User-facing labels for the owned routes. */
export const ACCOUNT_PROVIDER_LABELS: Readonly<Record<AccountProvider, string>> = {
  chatgpt: 'ChatGPT',
  antigravity: 'Google Antigravity',
}

/**
 * Resolve and detach account-provider settings.
 * @param providers - raw provider profiles from the composition or settings section.
 * @returns validated profiles keyed by known route.
 * @throws Error when an unknown route or invalid model override is supplied.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, AccountProviderProfile>> | undefined,
): Map<AccountProvider, AccountProviderProfile> {
  const resolved = new Map<AccountProvider, AccountProviderProfile>()
  for (const [provider, profile] of Object.entries(providers ?? {})) {
    if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`llm-account-auth: unknown provider "${provider}"`)
    }
    if (profile.endpoint !== undefined && profile.endpoint.trim().length === 0) {
      throw new Error(`llm-account-auth: provider "${provider}" has an empty endpoint`)
    }
    if (profile.callbackPath !== undefined
      && (!profile.callbackPath.startsWith('/') || profile.callbackPath.includes('?'))) {
      throw new Error(`llm-account-auth: provider "${provider}" callbackPath must be an absolute path`)
    }
    if (profile.callbackPort !== undefined
      && (!Number.isSafeInteger(profile.callbackPort) || profile.callbackPort < 0 || profile.callbackPort > 65535)) {
      throw new Error(`llm-account-auth: provider "${provider}" callbackPort must be an integer from 0 through 65535`)
    }
    if (profile.onboardingAttempts !== undefined
      && (!Number.isSafeInteger(profile.onboardingAttempts) || profile.onboardingAttempts < 1)) {
      throw new Error(`llm-account-auth: provider "${provider}" onboardingAttempts must be a positive integer`)
    }
    if (profile.onboardingDelayMs !== undefined
      && (!Number.isFinite(profile.onboardingDelayMs) || profile.onboardingDelayMs < 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" onboardingDelayMs must be non-negative`)
    }
    if (profile.defaultContextWindow !== undefined
      && (!Number.isSafeInteger(profile.defaultContextWindow) || profile.defaultContextWindow <= 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" defaultContextWindow must be a positive integer`)
    }
    if (profile.defaultMaxTokens !== undefined
      && (!Number.isSafeInteger(profile.defaultMaxTokens) || profile.defaultMaxTokens <= 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" defaultMaxTokens must be a positive integer`)
    }
    if (profile.streamIdleTimeoutMs !== undefined
      && (!Number.isFinite(profile.streamIdleTimeoutMs)
        || profile.streamIdleTimeoutMs <= 0
        || profile.streamIdleTimeoutMs > MAX_TIMER_DELAY_MS)) {
      throw new Error(
        `llm-account-auth: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    if (profile.maxRequestImageBytes !== undefined
      && (!Number.isSafeInteger(profile.maxRequestImageBytes) || profile.maxRequestImageBytes <= 0)) {
      throw new Error(`llm-account-auth: provider "${provider}" maxRequestImageBytes must be a positive integer`)
    }
    const models = profile.models
    if (models === undefined) {
      resolved.set(provider as AccountProvider, { ...profile })
      continue
    }
    const seen = new Set<string>()
    const detached = models.map((model) => {
      if (model.id.length === 0) throw new Error(`llm-account-auth: provider "${provider}" has an empty model id`)
      if (seen.has(model.id)) throw new Error(`llm-account-auth: provider "${provider}" repeats model "${model.id}"`)
      seen.add(model.id)
      if (model.name !== undefined && model.name.length === 0) {
        throw new Error(`llm-account-auth: provider "${provider}" model "${model.id}" has an empty name`)
      }
      for (const [field, value] of [
        ['contextWindow', model.contextWindow],
        ['maxTokens', model.maxTokens],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
          throw new Error(`llm-account-auth: provider "${provider}" model "${model.id}" ${field} must be a positive integer`)
        }
      }
      return {
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      }
    })
    if (detached.length === 0) throw new Error(`llm-account-auth: provider "${provider}" has no models`)
    resolved.set(provider as AccountProvider, {
      ...profile,
      models: detached,
    })
  }
  return resolved
}
