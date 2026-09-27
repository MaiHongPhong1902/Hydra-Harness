/** Account-scoped provider quota reports; credentials and raw responses stay in the Host. */
import type { Credential } from '@earendil-works/pi-ai'
import type {
  AuthorizationAccountId, AuthorizationUsage, AuthorizationUsageCredits, AuthorizationUsageWindow,
} from '@hydra/harness-authorization'
import { LlmError } from '@hydra/harness-llm'
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

function descriptionText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 1024) : undefined
}

function malformed(): never {
  throw new LlmError('Provider returned invalid usage data', 'MALFORMED_RESPONSE')
}

function percentage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return malformed()
  return value
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) return undefined
  return parsed
}

function timestamp(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const seconds = typeof value === 'string' ? Date.parse(value) / 1000 : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 8_640_000_000_000) return malformed()
  return Math.floor(seconds)
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error' })
  } catch (error) {
    if (init.signal?.aborted) throw error
    throw new LlmError('Provider usage request failed', 'USAGE_UNAVAILABLE', { cause: error })
  }
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

function antigravityWindowMinutes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const normalized = value.toLocaleLowerCase().replace(/[ _-]+/gu, '')
  if (/^(?:5h|5hours?|fivehours?)$/u.test(normalized)) return 300
  if (/^(?:weekly|week|7d|sevendays?)$/u.test(normalized)) return 10_080
  return undefined
}

function antigravityBucket(value: unknown, group: string | undefined): AuthorizationUsageWindow | undefined {
  const bucket = object(value) ?? malformed()
  if (bucket.remainingFraction === undefined) return undefined
  if (typeof bucket.remainingFraction !== 'number'
    || !Number.isFinite(bucket.remainingFraction) || bucket.remainingFraction < 0 || bucket.remainingFraction > 1) {
    return malformed()
  }
  const name = label(bucket.displayName) ?? label(bucket.bucketId)
  if (name === undefined) return malformed()
  const window = bucket.window
  if (window !== undefined && window !== null && typeof window !== 'string') return malformed()
  const description = bucket.description
  if (description !== undefined && description !== null && typeof description !== 'string') return malformed()
  const remainingAmount = bucket.remainingAmount
  if (remainingAmount === null || (remainingAmount !== undefined && integer(remainingAmount) === undefined)) return malformed()
  const disabled = bucket.disabled
  if (disabled !== undefined && typeof disabled !== 'boolean') return malformed()
  const windowLabel = label(window)
  const minutes = antigravityWindowMinutes(windowLabel)
  const descriptionLabel = descriptionText(description)
  const amount = remainingAmount === undefined ? undefined : integer(remainingAmount)
  const resetsAt = timestamp(bucket.resetTime)
  return {
    name, usedPercent: percentage((1 - bucket.remainingFraction) * 100),
    ...(group === undefined ? {} : { group }),
    ...(windowLabel === undefined ? {} : { window: windowLabel }),
    ...(minutes === undefined ? {} : { windowMinutes: minutes }),
    ...(descriptionLabel === undefined ? {} : { description: descriptionLabel }),
    ...(amount === undefined ? {} : { remainingAmount: amount }),
    ...(disabled === undefined ? {} : { disabled }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

function antigravitySummaryWindows(raw: Record<string, unknown>): AuthorizationUsageWindow[] {
  const rawGroups = raw.groups
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) return malformed()
  const rawBuckets = raw.buckets
  if (rawBuckets !== undefined && !Array.isArray(rawBuckets)) return malformed()
  const groups = rawGroups ?? []
  const limits = groups.flatMap((value): AuthorizationUsageWindow[] => {
    const group = object(value) ?? malformed()
    const groupName = label(group.displayName)
    const buckets = group.buckets
    if (buckets !== undefined && !Array.isArray(buckets)) return malformed()
    return (buckets ?? []).flatMap((bucket) => {
      const parsed = antigravityBucket(bucket, groupName)
      return parsed === undefined ? [] : [parsed]
    })
  })
  if (limits.length > 256) return malformed()
  if (limits.length > 0 || groups.length > 0) return limits
  const fallback = (rawBuckets ?? []).flatMap((bucket) => {
    const parsed = antigravityBucket(bucket, undefined)
    return parsed === undefined ? [] : [parsed]
  })
  if (fallback.length > 256) return malformed()
  return fallback
}

function antigravityModelWindows(raw: Record<string, unknown>): AuthorizationUsageWindow[] {
  const models = object(raw.models) ?? malformed()
  const limits = Object.entries(models).flatMap(([id, value]): AuthorizationUsageWindow[] => {
    const model = object(value)
    const quota = object(model?.quotaInfo)
    if (model?.isInternal === true || quota?.remainingFraction === undefined) return []
    const remaining = quota.remainingFraction
    if (typeof remaining !== 'number' || remaining < 0 || remaining > 1) return malformed()
    const name = label(model?.displayName) ?? label(id)
    if (name === undefined) return malformed()
    const resetsAt = timestamp(quota.resetTime)
    return [{ name, usedPercent: percentage((1 - remaining) * 100),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    }]
  })
  if (limits.length > 256) return malformed()
  return limits
}

function antigravityCredits(account: Record<string, unknown>): AuthorizationUsageCredits[] {
  const tiers = [
    ['current', account.currentTier], ['paid', account.paidTier], ['g1', account.g1Tier],
  ] as const
  return tiers.flatMap(([tier, value]) => {
    const row = object(value)
    const source = row?.availableCredits
    if (source === undefined || source === null) return []
    const credits = object(source) ?? malformed()
    const creditType = credits.creditType
    if (creditType !== undefined && creditType !== null && label(creditType) === undefined) return malformed()
    const creditAmount = credits.creditAmount
    const minimum = credits.minimumCreditAmountForUsage
    if (creditAmount === null || minimum === null
      || (creditAmount !== undefined && integer(creditAmount) === undefined)
      || (minimum !== undefined && integer(minimum) === undefined)) return malformed()
    const amount = creditAmount === undefined ? undefined : integer(creditAmount)
    const minimumAmount = minimum === undefined ? undefined : integer(minimum)
    if (creditType === undefined && amount === undefined && minimumAmount === undefined) return []
    const creditTypeLabel = label(creditType)
    return [{ tier, ...(creditTypeLabel === undefined ? {} : { creditType: creditTypeLabel }),
      ...(amount === undefined ? {} : { creditAmount: amount }),
      ...(minimumAmount === undefined ? {} : { minimumCreditAmountForUsage: minimumAmount }),
    }]
  })
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
  let limits: AuthorizationUsageWindow[]
  try {
    const summary = await requestJson(`${base}:retrieveUserQuotaSummary`, { ...init, body: JSON.stringify({ project }) })
    limits = antigravitySummaryWindows(summary)
  } catch (error) {
    if (!(error instanceof LlmError) || error.code !== 'USAGE_UNAVAILABLE') throw error
    const models = await requestJson(`${base}:fetchAvailableModels`, { ...init, body: JSON.stringify({ project }) })
    limits = antigravityModelWindows(models)
  }
  let planType: string | undefined
  let credits: AuthorizationUsageCredits[] | undefined
  try {
    const account = await requestJson(`${base}:loadCodeAssist`, { ...init,
      body: JSON.stringify({ cloudaicompanionProject: project,
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
    })
    const tier = object(account.paidTier) ?? object(account.currentTier)
    planType = label(tier?.name) ?? label(tier?.id)
    const balances = antigravityCredits(account)
    if (balances.length > 0) credits = balances
  } catch {
    // Tier and credit discovery is optional; it must not erase quota measurements.
    signal.throwIfAborted()
  }
  return { limits, fetchedAt: Date.now() / 1000,
    ...(planType === undefined ? {} : { planType }), ...(credits === undefined ? {} : { credits }),
  }
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
