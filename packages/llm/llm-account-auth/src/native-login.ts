/** Cursor PKCE polling and Kiro AWS device authorization, with Host-owned grant writes. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { AuthorizationSession } from '@hydraharness/harness-authorization'
import { LlmError } from '@hydraharness/harness-llm'
import type { AccountPool } from './accounts.ts'
import type { AccountProviderProfile } from './config.ts'
import { accountJson } from './json-response.ts'
import { MAX_TIMER_DELAY_MS } from '@hydraharness/harness-timeout'

type Json = Record<string, unknown>

function record(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LlmError('Account provider returned invalid JSON.', 'INVALID_CREDENTIAL')
  return value as Json
}

function text(value: Json, field: string): string {
  const result = value[field]
  if (typeof result !== 'string' || result.length === 0) throw new LlmError(`Account provider omitted ${field}.`, 'INVALID_CREDENTIAL')
  return result
}

function seconds(value: Json, field: string): number {
  const result = value[field]
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0 || result > MAX_TIMER_DELAY_MS / 1000) throw new LlmError(`Account provider returned invalid ${field}.`, 'INVALID_CREDENTIAL')
  return result * 1000
}


async function post(url: string, body: Json, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

function expiry(access: string): number {
  const encoded = access.split('.')[1]
  if (encoded !== undefined) {
    try {
      const data = record(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
      if (typeof data['exp'] === 'number' && Number.isFinite(data['exp']) && data['exp'] > 0) return data['exp'] * 1000
    } catch { /* Opaque access tokens have no JWT expiry; use a conservative refresh interval. */ }
  }
  return Date.now() + 60 * 60 * 1000
}

/**
 * Sign in through Cursor's PKCE flow and store the complete grant.
 * @param session - browser notices and cancellation supplied by authorization.
 * @param pool - durable account owner.
 * @param profile - polling and deadline controls.
 * @returns once the account is stored; cancellation never commits a grant.
 */
export async function loginCursor(session: AuthorizationSession, pool: AccountPool, profile: AccountProviderProfile): Promise<void> {
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(profile.loginTimeoutMs ?? 900_000)])
  const verifier = randomBytes(96).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const uuid = randomUUID()
  const query = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' })
  session.notify({ message: 'Continue signing in to Cursor in your browser.', url: `https://cursor.com/loginDeepControl?${query}` })
  const poll = `https://api2.cursor.sh/auth/poll?${new URLSearchParams({ uuid, verifier })}`
  for (;;) {
    await delay(profile.loginPollIntervalMs ?? 1000, undefined, { signal })
    const response = await fetch(poll, { redirect: 'error', signal })
    if (response.status === 404 || response.status === 202) { await response.body?.cancel(); continue }
    if (!response.ok) { await response.body?.cancel(); throw new LlmError(`Cursor login failed (HTTP ${response.status}).`, 'INVALID_CREDENTIAL') }
    const data = await accountJson(response, signal)
    const access = text(data, 'accessToken')
    const refresh = text(data, 'refreshToken')
    signal.throwIfAborted()
    await pool.add(undefined, { type: 'oauth', access, refresh, expires: expiry(access) }, signal)
    return
  }
}

/**
 * Resolve Kiro's region and OIDC host before starting network operations.
 * @param profile - configured regional settings.
 * @returns region, AWS OIDC host, and start URL.
 */
export function kiroIdentity(profile: AccountProviderProfile): { region: string; oidc: string; startURL: string } {
  const region = profile.region ?? 'us-east-1'
  return { region, oidc: `https://oidc.${region}.amazonaws.com`, startURL: profile.startURL ?? 'https://view.awsapps.com/start' }
}

/**
 * Register a public AWS client, authorize its device, and store its refresh credentials.
 * @param session - browser notices and cancellation supplied by authorization.
 * @param pool - durable account owner.
 * @param profile - region, IAM Identity Center start URL, and deadline.
 * @returns once the account is durably stored.
 */
export async function loginKiro(session: AuthorizationSession, pool: AccountPool, profile: AccountProviderProfile): Promise<void> {
  const { region, oidc, startURL } = kiroIdentity(profile)
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(profile.loginTimeoutMs ?? 900_000)])
  const registered = await post(`${oidc}/client/register`, { clientName: 'Hydra Harness', clientType: 'public',
    scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    issuerUrl: profile.issuerURL ?? 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6' }, signal)
  if (!registered.ok) { await registered.body?.cancel(); throw new LlmError(`Kiro client registration failed (HTTP ${registered.status}).`, 'INVALID_CREDENTIAL') }
  const client = await accountJson(registered, signal)
  const clientId = text(client, 'clientId')
  const clientSecret = text(client, 'clientSecret')
  const started = await post(`${oidc}/device_authorization`, { clientId, clientSecret, startUrl: startURL }, signal)
  if (!started.ok) { await started.body?.cancel(); throw new LlmError(`Kiro device authorization failed (HTTP ${started.status}).`, 'INVALID_CREDENTIAL') }
  const device = await accountJson(started, signal)
  const deviceCode = text(device, 'deviceCode')
  const userCode = text(device, 'userCode')
  const verification = new URL(typeof device['verificationUriComplete'] === 'string' ? device['verificationUriComplete'] : text(device, 'verificationUri'))
  if (verification.protocol !== 'https:' || verification.username || verification.password) throw new LlmError('Kiro returned an invalid verification URL.', 'INVALID_CREDENTIAL')
  const pollingSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(seconds(device, 'expiresIn'), profile.loginTimeoutMs ?? 900_000))])
  let interval = device['interval'] === undefined ? 5000 : seconds(device, 'interval')
  session.notify({ message: 'Authorize Hydra with AWS Builder ID or your IAM Identity Center account.', url: verification.href, code: userCode })
  for (;;) {
    await delay(interval, undefined, { signal: pollingSignal })
    const response = await post(`${oidc}/token`, { clientId, clientSecret, deviceCode, grantType: 'urn:ietf:params:oauth:grant-type:device_code' }, pollingSignal)
    const data = await accountJson(response, signal)
    if (response.ok) {
      const lifetime = seconds(data, 'expiresIn')
      pollingSignal.throwIfAborted()
      await pool.add(undefined, { type: 'oauth', access: text(data, 'accessToken'), refresh: text(data, 'refreshToken'),
        expires: Date.now() + lifetime, clientId, clientSecret, region,
        ...typeof data['profileArn'] === 'string' ? { profileArn: data['profileArn'] } : {},
        ...typeof client['clientSecretExpiresAt'] === 'number' ? { clientSecretExpiresAt: client['clientSecretExpiresAt'] } : {} }, pollingSignal)
      return
    }
    if (data['error'] === 'authorization_pending' || data['__type'] === 'AuthorizationPendingException') continue
    if (data['error'] === 'slow_down' || data['__type'] === 'SlowDownException') { interval = Math.min(interval + 5000, MAX_TIMER_DELAY_MS); continue }
    throw new LlmError(`Kiro login failed (HTTP ${response.status}).`, 'INVALID_CREDENTIAL')
  }
}

/**
 * Refresh one native grant while its owning pool holds the credential lock.
 * @param provider - native subscription protocol.
 * @param current - stored OAuth grant.
 * @param signal - cancellation for refresh and subsequent durable commit.
 * @returns refreshed credentials with provider metadata retained.
 */
export async function refreshNativeAccount(provider: 'cursor' | 'kiro', current: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
  if (provider === 'kiro') {
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(text(current, 'region'))) throw new LlmError('Kiro grant has an invalid AWS region.', 'INVALID_CREDENTIAL')
    if (typeof current['clientSecretExpiresAt'] === 'number' && current['clientSecretExpiresAt'] * 1000 <= Date.now()) throw new LlmError('Kiro client registration expired; sign in again.', 'INVALID_CREDENTIAL')
  }
  const url = provider === 'cursor' ? 'https://api2.cursor.sh/auth/exchange_user_api_key'
    : `https://oidc.${text(current, 'region')}.amazonaws.com/token`
  const body = provider === 'cursor' ? {} : {
    clientId: text(current, 'clientId'), clientSecret: text(current, 'clientSecret'), refreshToken: current.refresh, grantType: 'refresh_token',
  }
  const headers: Record<string, string> = provider === 'cursor' ? { Authorization: `Bearer ${current.refresh}` } : {}
  const response = await post(url, body, signal, headers)
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(`${provider} token refresh failed (HTTP ${response.status}).`, 'INVALID_CREDENTIAL')
  }
  const data = await accountJson(response, signal)
  const access = text(data, 'accessToken')
  const lifetime = provider === 'kiro' ? seconds(data, 'expiresIn') : undefined
  signal.throwIfAborted()
  return { ...current, access, refresh: typeof data['refreshToken'] === 'string' && data['refreshToken'].length > 0 ? data['refreshToken'] : current.refresh,
    expires: lifetime === undefined ? expiry(access) : Date.now() + lifetime }
}
