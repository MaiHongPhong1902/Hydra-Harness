/** Account-scoped provider quota reports; credentials and raw responses stay in the Host. */
import type { Credential } from '@earendil-works/pi-ai'
import type { AuthorizationAccountId, AuthorizationUsage, AuthorizationUsageWindow } from '@hydra1902/harness-authorization'
import { LlmError } from '@hydra1902/harness-llm'
import type { AccountPool } from './accounts.ts'
import type { AccountProvider, AccountProviderProfile } from './config.ts'
import {
  ANTIGRAVITY_API_ENDPOINT, ANTIGRAVITY_API_VERSION, ANTIGRAVITY_USER_AGENT, refreshAntigravity,
} from './antigravity-oauth.ts'

type OAuthCredential = Extract<Credential, { type: 'oauth' }>

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 128) : undefined
}

function malformed(): never {
  throw new LlmError('Provider returned invalid usage data', 'MALFORMED_RESPONSE')
}

function percentage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return malformed()
  return value
}

function timestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const seconds = typeof value === 'string' ? Date.parse(value) / 1000 : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 8_640_000_000_000) return malformed()
  return Math.floor(seconds)
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: 'error' })
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(`Provider usage request failed with HTTP ${response.status}`, 'USAGE_UNAVAILABLE')
  }
  const result = object(await response.json())
  return result ?? malformed()
}

function chatGptWindows(name: string, value: unknown): AuthorizationUsageWindow[] {
  if (value === undefined || value === null) return []
  const rate = object(value) ?? malformed()
  return [rate.primary_window, rate.secondary_window].flatMap((value) => {
    if (value === undefined || value === null) return []
    const row = object(value) ?? malformed()
    const seconds = row.limit_window_seconds
    if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0)) return malformed()
    const resetsAt = timestamp(row.reset_at)
    return [{ name, usedPercent: percentage(row.used_percent),
      ...(typeof seconds === 'number' ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }]
  })
}

function resetCount(value: unknown): number | undefined {
  const record = object(value)
  const count = record?.available_count
  if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) return count
  return Array.isArray(record?.credits) ? record.credits.length : undefined
}

async function chatGptUsage(credential: OAuthCredential, signal: AbortSignal): Promise<AuthorizationUsage> {
  const accountId = label(credential.accountId)
  if (accountId === undefined) throw new LlmError('ChatGPT account is missing its account id', 'INVALID_CREDENTIAL')
  const base = 'https://chatgpt.com/backend-api/wham'
  const init = { signal, headers: { accept: 'application/json', 'cache-control': 'no-store',
    authorization: `Bearer ${credential.access}`, 'chatgpt-account-id': accountId, 'user-agent': 'hydra-harness' } }
  const raw = await requestJson(`${base}/usage`, init)
  if (!Object.hasOwn(raw, 'rate_limit') && !Object.hasOwn(raw, 'plan_type')) return malformed()
  const limits = chatGptWindows('Codex', raw.rate_limit)
  limits.push(...chatGptWindows('Code review', raw.code_review_rate_limit))
  if (raw.additional_rate_limits !== undefined && raw.additional_rate_limits !== null) {
    if (!Array.isArray(raw.additional_rate_limits)) return malformed()
    for (const item of raw.additional_rate_limits) {
      const rate = object(item) ?? malformed()
      const name = label(rate.limit_name) ?? label(rate.metered_feature)
      if (name === undefined) return malformed()
      limits.push(...chatGptWindows(name, rate.rate_limit))
    }
  }
  let bankedResetCount = resetCount(raw.rate_limit_reset_credits)
  if (bankedResetCount === undefined) {
    try {
      bankedResetCount = resetCount(await requestJson(`${base}/rate-limit-reset-credits`, init))
    } catch {
      // Older accounts may not expose reset credits; their quota report still stands.
      signal.throwIfAborted()
    }
  }
  const planType = label(raw.plan_type)
  if (limits.length > 256) return malformed()
  return { limits, fetchedAt: Date.now() / 1000,
    ...(planType === undefined ? {} : { planType }),
    ...(bankedResetCount === undefined ? {} : { bankedResetCount }),
  }
}

async function antigravityUsage(
  credential: OAuthCredential, profile: AccountProviderProfile, signal: AbortSignal,
): Promise<AuthorizationUsage> {
  const project = label(credential.projectId)
  if (project === undefined) throw new LlmError('Antigravity account is missing its project', 'INVALID_CREDENTIAL')
  const base = `${(profile.endpoint ?? ANTIGRAVITY_API_ENDPOINT).replace(/\/+$/u, '')}/${ANTIGRAVITY_API_VERSION}`
  const init = { method: 'POST', signal, headers: {
    authorization: `Bearer ${credential.access}`, accept: 'application/json',
    'content-type': 'application/json', 'user-agent': ANTIGRAVITY_USER_AGENT,
  } }
  const raw = await requestJson(`${base}:fetchAvailableModels`, { ...init, body: JSON.stringify({ project }) })
  const models = object(raw.models) ?? malformed()
  const limits = Object.entries(models).flatMap(([id, value]): AuthorizationUsageWindow[] => {
    const model = object(value)
    const quota = object(model?.quotaInfo)
    if (model?.isInternal === true || quota?.remainingFraction === undefined) return []
    const remaining = quota.remainingFraction
    if (typeof remaining !== 'number' || remaining < 0 || remaining > 1) return malformed()
    const resetsAt = timestamp(quota.resetTime)
    return [{ name: label(model?.displayName) ?? id.slice(0, 128), usedPercent: percentage((1 - remaining) * 100),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }]
  })
  let planType: string | undefined
  try {
    const account = await requestJson(`${base}:loadCodeAssist`, { ...init,
      body: JSON.stringify({ cloudaicompanionProject: project,
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
    })
    const tier = object(account.paidTier) ?? object(account.currentTier)
    planType = label(tier?.name) ?? label(tier?.id)
  } catch {
    // Tier discovery is optional; it must not erase model quota measurements.
    signal.throwIfAborted()
  }
  if (limits.length > 256) return malformed()
  return { limits, fetchedAt: Date.now() / 1000, ...(planType === undefined ? {} : { planType }) }
}

/**
 * Read one account's provider quota, refreshing an expired grant under its storage lock.
 * @param pool - Host-owned account pool.
 * @param id - connected account identity; never falls back to another account.
 * @param provider - native provider route.
 * @param profile - current provider endpoint configuration.
 * @param timeoutMs - deadline including OAuth refresh and response bodies.
 * @param signal - caller cancellation.
 * @returns normalized provider data without credentials or raw responses.
 */
export async function readAccountUsage(
  pool: AccountPool, id: AuthorizationAccountId, provider: AccountProvider,
  profile: AccountProviderProfile, timeoutMs: number, signal?: AbortSignal,
): Promise<AuthorizationUsage> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  return pool.withAccount(id, async () => {
    let selected: OAuthCredential | undefined
    await pool.credentials.modify(provider, async (current) => {
      combined.throwIfAborted()
      if (current?.type !== 'oauth') throw new LlmError('Account is not connected', 'MISSING_CREDENTIAL')
      selected = current
      if (current.expires > Date.now()) return undefined
      if (provider === 'chatgpt') {
        const { openaiCodexProvider } = await import('@earendil-works/pi-ai/providers/openai-codex')
        const oauth = openaiCodexProvider().auth.oauth
        if (oauth === undefined) throw new LlmError('ChatGPT OAuth is unavailable', 'INVALID_CREDENTIAL')
        selected = await oauth.refresh(current, combined)
      } else {
        if (typeof current.projectId !== 'string') throw new LlmError('Antigravity project is missing', 'INVALID_CREDENTIAL')
        selected = { ...current, ...await refreshAntigravity({ refresh: current.refresh, projectId: current.projectId }, {}, combined) }
      }
      combined.throwIfAborted()
      return selected
    })
    combined.throwIfAborted()
    if (selected === undefined) throw new LlmError('Account is not connected', 'MISSING_CREDENTIAL')
    const result = provider === 'chatgpt'
      ? await chatGptUsage(selected, combined) : await antigravityUsage(selected, profile, combined)
    combined.throwIfAborted()
    return result
  })
}
