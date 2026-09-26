/**
 * Google Antigravity OAuth and Cloud Code Assist account setup.
 *
 * The loopback listener belongs to one login attempt and closes when it settles.
 * Callers own credential storage and initiate token refresh during model use.
 *
 * @module hydra-llm-account-auth/antigravity-oauth
 */

import { createServer, type Server } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'
import { LlmError } from '@hydra1902/harness-llm'

/** OAuth client id published by the Antigravity desktop client. */
export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
/** OAuth client secret published by the Antigravity desktop client. */
export const ANTIGRAVITY_CLIENT_SECRET = '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'
/** Default loopback port used by the desktop client. */
export const ANTIGRAVITY_CALLBACK_PORT = 51121
/** Default loopback path used by the desktop client. */
export const ANTIGRAVITY_CALLBACK_PATH = '/oauth-callback'
/** Google OAuth authorization endpoint. */
export const ANTIGRAVITY_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Google OAuth token endpoint. */
export const ANTIGRAVITY_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** Google user profile endpoint. */
export const ANTIGRAVITY_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'
/** Cloud Code Assist production control-plane endpoint. */
export const ANTIGRAVITY_API_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
/** Cloud Code Assist daily control-plane endpoint. */
export const ANTIGRAVITY_DAILY_API_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
/** Cloud Code Assist API version. */
export const ANTIGRAVITY_API_VERSION = 'v1internal'
/** Exact OAuth scopes requested by Antigravity. */
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const

/** Short user agent used by normal Antigravity requests. */
export const ANTIGRAVITY_USER_AGENT = 'antigravity/hub/2.9.1 darwin/arm64'
/** Additional client marker used by the onboarding control plane. */
export const ANTIGRAVITY_ONBOARD_API_CLIENT = 'gl-node/22.21.1'
/** Node client suffix used by the onboarding control plane. */
export const ANTIGRAVITY_ONBOARD_USER_AGENT = `${ANTIGRAVITY_USER_AGENT} google-api-nodejs-client/10.3.0`
/** Five-minute token safety margin used before an access token is considered expired. */
export const ANTIGRAVITY_TOKEN_SAFETY_MS = 5 * 60 * 1000

/** Access and refresh tokens stored for one Antigravity account. */
export interface AntigravityCredentials {
  /** Current bearer token. */
  access: string
  /** Long-lived OAuth refresh token. */
  refresh: string
  /** Absolute expiry in milliseconds, including the safety margin. */
  expires: number
  /** Cloud Code Assist project selected for this account. */
  projectId: string
  /** Optional Google account label. */
  email?: string
}

/** Token response fields accepted from Google's OAuth endpoint. */
export interface AntigravityTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  token_type?: unknown
}

/** A fetch function that can be replaced by a test or a host proxy. */
export type AntigravityFetch = typeof fetch

/** The subset of an authorization session used by this protocol. */
export interface AntigravityAuthorizationInteraction {
  /** Whole-login cancellation. */
  readonly signal?: AbortSignal
  /** Show a transient instruction or URL to the user. */
  notify(notice: { message: string; url?: string; code?: string }): void
  /** Collect a manual callback URL when the browser cannot reach localhost. */
  prompt(prompt: {
    kind: 'secret'
    message: string
    placeholder?: string
    signal?: AbortSignal
  }): Promise<string>
}

/** Options that make network, clock, and loopback behavior injectable. */
export interface AntigravityOAuthOptions {
  /** Fetch implementation; defaults to the global fetch. */
  fetch?: AntigravityFetch
  /** Loopback host; defaults to 127.0.0.1. */
  callbackHost?: string
  /** Loopback port; defaults to 51121. `0` asks the OS for a free port. */
  callbackPort?: number
  /** Callback path; defaults to `/oauth-callback`. */
  callbackPath?: string
  /** Clock used to calculate expiry. */
  now?: () => number
  /** Number of onboarding attempts; defaults to 5. */
  onboardingAttempts?: number
  /** Delay between incomplete onboarding responses; defaults to 2 seconds. */
  onboardingDelayMs?: number
}

interface ResolvedOAuthOptions {
  readonly fetch: AntigravityFetch
  readonly callbackHost: string
  readonly callbackPort: number
  readonly callbackPath: string
  readonly now: () => number
  readonly onboardingAttempts: number
  readonly onboardingDelayMs: number
}

interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

interface CallbackCode {
  readonly code: string
  readonly state: string
}

interface CallbackServer {
  readonly server: Server
  readonly port: number
  readonly callback: Promise<CallbackCode>
}

type JsonRecord = Record<string, unknown>

function resolvedOptions(options: AntigravityOAuthOptions): ResolvedOAuthOptions {
  const callbackPath = options.callbackPath ?? ANTIGRAVITY_CALLBACK_PATH
  if (!callbackPath.startsWith('/') || /[?#]/.test(callbackPath)) {
    throw new LlmError('Antigravity OAuth callbackPath must be an absolute path', 'INVALID_AUTH_CONFIG')
  }
  const callbackPort = options.callbackPort ?? ANTIGRAVITY_CALLBACK_PORT
  if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65535) {
    throw new LlmError('Antigravity OAuth callbackPort must be an integer from 0 through 65535', 'INVALID_AUTH_CONFIG')
  }
  const callbackHost = options.callbackHost ?? '127.0.0.1'
  if (typeof callbackHost !== 'string'
    || !['127.0.0.1', 'localhost', '::1'].includes(callbackHost.toLowerCase())) {
    throw new LlmError('Antigravity OAuth callbackHost must be localhost or a loopback address', 'INVALID_AUTH_CONFIG')
  }
  const onboardingAttempts = options.onboardingAttempts ?? 5
  if (!Number.isSafeInteger(onboardingAttempts) || onboardingAttempts < 1) {
    throw new LlmError('Antigravity onboardingAttempts must be a positive integer', 'INVALID_AUTH_CONFIG')
  }
  const onboardingDelayMs = options.onboardingDelayMs ?? 2000
  if (!Number.isFinite(onboardingDelayMs) || onboardingDelayMs < 0) {
    throw new LlmError('Antigravity onboardingDelayMs must be non-negative', 'INVALID_AUTH_CONFIG')
  }
  return {
    fetch: options.fetch ?? fetch,
    callbackHost,
    callbackPort,
    callbackPath,
    now: options.now ?? Date.now,
    onboardingAttempts,
    onboardingDelayMs,
  }
}

/** Generate a PKCE verifier and S256 challenge. */
function createAntigravityPkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Return the default loopback redirect URI for a callback port and path. */
function antigravityCallbackUri(
  port = ANTIGRAVITY_CALLBACK_PORT,
  path = ANTIGRAVITY_CALLBACK_PATH,
): string {
  /* v8 ignore next -- this private helper receives only the absolute path validated by resolvedOptions. */
  return `http://localhost:${String(port)}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Build Google's Antigravity authorization URL.
 * @param state - random CSRF state, independent of the private PKCE verifier.
 * @param redirectUri - registered loopback redirect URI.
 * @param challenge - S256 PKCE challenge.
 * @returns the encoded authorization URL.
 */
export function buildAntigravityAuthorizationUrl(
  state: string,
  redirectUri: string,
  challenge?: string,
): string {
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: ANTIGRAVITY_CLIENT_ID,
    prompt: 'consent',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY_SCOPES.join(' '),
    state,
    ...(challenge === undefined ? {} : { code_challenge: challenge, code_challenge_method: 'S256' }),
  })
  return `${ANTIGRAVITY_AUTH_ENDPOINT}?${params.toString()}`
}

function objectRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function responseStatus(response: Response): number {
  /* v8 ignore next -- the Fetch Response status getter always supplies an integer. */
  return Number.isInteger(response.status) ? response.status : 0
}

function abortError(signal: AbortSignal | undefined): LlmError | undefined {
  return signal?.aborted
    ? new LlmError('Antigravity request was aborted', 'ABORTED', { cause: signal.reason })
    : undefined
}

function abortFailure(signal: AbortSignal | undefined): LlmError {
  /* v8 ignore next -- every caller has observed cancellation on this same signal. */
  return abortError(signal) ?? new LlmError('Antigravity request was aborted', 'ABORTED')
}

function classifyHttp(status: number, message: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return /quota|exhaust|resource.?exhaust/i.test(message) ? 'QUOTA' : 'RATE_LIMIT'
  if (status >= 400 && status < 500) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return 'AUTH'
}

async function responseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000)
  } catch {
    return ''
  }
}

async function responseJson(response: Response, operation: string): Promise<JsonRecord> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // JSON parser errors can quote a credential-bearing response body.
    throw new LlmError(`Antigravity ${operation} returned malformed JSON`, 'MALFORMED_RESPONSE')
  }
  const object = objectRecord(parsed)
  if (object === undefined) {
    throw new LlmError(`Antigravity ${operation} returned a non-object response`, 'MALFORMED_RESPONSE')
  }
  return object
}

async function requestJson(
  url: string,
  init: RequestInit,
  operation: string,
  fetchImplementation: AntigravityFetch,
): Promise<JsonRecord> {
  let response: Response
  try {
    response = await fetchImplementation(url, init)
  } catch {
    if (init.signal?.aborted) throw abortFailure(init.signal)
    throw new LlmError(`Antigravity ${operation} request failed`, 'TRANSPORT')
  }
  if (!response.ok) {
    const detail = await responseText(response)
    throw new LlmError(
      `Antigravity ${operation} failed with HTTP ${String(responseStatus(response))}`,
      classifyHttp(responseStatus(response), detail),
      { status: responseStatus(response) },
    )
  }
  return responseJson(response, operation)
}

/**
 * Exchange an authorization code for access and refresh tokens.
 * @param code - one-time code returned to the validated callback.
 * @param redirectUri - loopback URI used in the authorization request.
 * @param codeVerifier - secret PKCE verifier for this attempt.
 * @param options - protocol transport and callback configuration.
 * @param signal - cancellation for the token exchange.
 * @returns tokens and their advertised lifetime in seconds.
 */
export async function exchangeAntigravityCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  options: AntigravityOAuthOptions = {},
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expiresIn: number }> {
  const resolved = resolvedOptions(options)
  const checkedCode = nonEmptyString(code)
  const checkedVerifier = nonEmptyString(codeVerifier)
  if (checkedCode === undefined || checkedVerifier === undefined) {
    throw new LlmError('Antigravity OAuth code and verifier are required', 'INVALID_AUTH_RESPONSE')
  }
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    code: checkedCode,
    code_verifier: checkedVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  })
  const token = await requestJson(
    ANTIGRAVITY_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal ?? null,
    },
    'token exchange',
    resolved.fetch,
  ) as AntigravityTokenResponse
  const access = nonEmptyString(token.access_token)
  const refresh = nonEmptyString(token.refresh_token)
  const expiresIn = typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
    ? token.expires_in
    : Number(token.expires_in)
  if (access === undefined || refresh === undefined || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new LlmError('Antigravity token exchange returned incomplete credentials', 'INVALID_AUTH_RESPONSE')
  }
  return { access, refresh, expiresIn }
}

/**
 * Refresh an Antigravity access token and preserve refresh-token rotation.
 * @param credentials - stored grant whose refresh token authorizes the exchange.
 * @param options - protocol transport and clock configuration.
 * @param signal - cancellation for the token exchange.
 * @returns the replacement grant; the caller owns its durable commit.
 */
export async function refreshAntigravity(
  credentials: Pick<AntigravityCredentials, 'refresh' | 'projectId'> & Partial<Pick<AntigravityCredentials, 'email'>>,
  options: AntigravityOAuthOptions = {},
  signal?: AbortSignal,
): Promise<AntigravityCredentials> {
  const resolved = resolvedOptions(options)
  const refresh = nonEmptyString(credentials.refresh)
  const projectId = nonEmptyString(credentials.projectId)
  if (refresh === undefined || projectId === undefined) {
    throw new LlmError('Antigravity credentials are missing refresh or projectId', 'INVALID_CREDENTIAL')
  }
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refresh,
  })
  const token = await requestJson(
    ANTIGRAVITY_TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: signal ?? null,
    },
    'token refresh',
    resolved.fetch,
  ) as AntigravityTokenResponse
  const access = nonEmptyString(token.access_token)
  const rotated = nonEmptyString(token.refresh_token)
  const expiresIn = typeof token.expires_in === 'number' && Number.isFinite(token.expires_in)
    ? token.expires_in
    : Number(token.expires_in)
  if (access === undefined || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new LlmError('Antigravity token refresh returned incomplete credentials', 'INVALID_AUTH_RESPONSE')
  }
  return {
    access,
    refresh: rotated ?? refresh,
    expires: resolved.now() + expiresIn * 1000 - ANTIGRAVITY_TOKEN_SAFETY_MS,
    projectId,
    ...(credentials.email === undefined ? {} : { email: credentials.email }),
  }
}

/** Fetch the optional Google account email for a bearer token. */
async function fetchAntigravityUserInfo(
  accessToken: string,
  options: AntigravityOAuthOptions = {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  const resolved = resolvedOptions(options)
  const token = nonEmptyString(accessToken)
  /* v8 ignore next -- the sole caller passes the nonempty access token validated by exchangeAntigravityCode. */
  if (token === undefined) throw new LlmError('Antigravity userinfo needs an access token', 'INVALID_CREDENTIAL')
  let response: Response
  try {
    response = await resolved.fetch(ANTIGRAVITY_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': ANTIGRAVITY_USER_AGENT },
      signal: signal ?? null,
    })
  } catch {
    if (signal?.aborted) throw abortFailure(signal)
    return undefined
  }
  if (!response.ok) {
    // Email is a label only; a failed profile call must not discard a valid grant.
    await responseText(response)
    return undefined
  }
  try {
    return nonEmptyString((await responseJson(response, 'userinfo')).email)
  } catch {
    return undefined
  }
}

function extractProjectId(value: unknown): string | undefined {
  const object = objectRecord(value)
  if (object === undefined) return nonEmptyString(value)
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const candidate = object[key]
    const direct = nonEmptyString(candidate)
    if (direct !== undefined) return direct
    const nested = objectRecord(candidate)
    const nestedId = nonEmptyString(nested?.id) ?? nonEmptyString(nested?.projectId)
    if (nestedId !== undefined) return nestedId
  }
  return undefined
}

function defaultTierId(response: JsonRecord): string {
  if (Array.isArray(response.allowedTiers)) {
    for (const raw of response.allowedTiers) {
      const tier = objectRecord(raw)
      if (tier?.isDefault === true) {
        const id = nonEmptyString(tier.id)
        if (id !== undefined) return id
      }
    }
  }
  const currentTier = objectRecord(response.currentTier)
  return nonEmptyString(currentTier?.id) ?? 'free-tier'
}

function onboardingMetadata(): JsonRecord {
  return { ide_type: 'ANTIGRAVITY', ide_version: '2.9.1', ide_name: 'antigravity' }
}

function loadMetadata(): JsonRecord {
  return { ideType: 'ANTIGRAVITY' }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  if (signal?.aborted) throw abortFailure(signal)
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(abortFailure(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
    /* v8 ignore next -- native AbortSignal cannot change during synchronous listener registration after the initial check. */
    if (signal?.aborted) abort()
  })
}

/**
 * Discover the Cloud Code Assist project, onboarding the account when the
 * control plane has not provisioned one yet.
 * @param accessToken - bearer token authorized for Cloud Code Assist.
 * @param options - transport and bounded onboarding configuration.
 * @param signal - cancellation for discovery and onboarding.
 * @returns the provisioned project identifier.
 */
export async function loadAntigravityProject(
  accessToken: string,
  options: AntigravityOAuthOptions = {},
  signal?: AbortSignal,
): Promise<string> {
  const resolved = resolvedOptions(options)
  const token = nonEmptyString(accessToken)
  if (token === undefined) throw new LlmError('Antigravity project lookup needs an access token', 'INVALID_CREDENTIAL')
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: '*/*',
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_USER_AGENT,
  }
  const load = await requestJson(
    `${ANTIGRAVITY_API_ENDPOINT}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`,
    { method: 'POST', headers, body: JSON.stringify({ metadata: loadMetadata() }), signal: signal ?? null },
    'loadCodeAssist',
    resolved.fetch,
  )
  const loaded = extractProjectId(load)
  if (loaded !== undefined) return loaded

  const body = JSON.stringify({ tier_id: defaultTierId(load), metadata: onboardingMetadata() })
  let lastFailure: unknown
  for (let attempt = 0; attempt < resolved.onboardingAttempts; attempt += 1) {
    try {
      const onboard = await requestJson(
        `${ANTIGRAVITY_DAILY_API_ENDPOINT}/${ANTIGRAVITY_API_VERSION}:onboardUser`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'User-Agent': ANTIGRAVITY_ONBOARD_USER_AGENT,
            'X-Goog-Api-Client': ANTIGRAVITY_ONBOARD_API_CLIENT,
          },
          body,
          signal: signal ?? null,
        },
        'onboardUser',
        resolved.fetch,
      )
      if (onboard.done === true) {
        const project = extractProjectId(onboard.response) ?? extractProjectId(onboard)
        if (project !== undefined) return project
        throw new LlmError('Antigravity onboarding completed without a project id', 'INVALID_AUTH_RESPONSE')
      }
      lastFailure = new LlmError('Antigravity onboarding is still pending', 'ONBOARDING_PENDING')
    } catch (error: unknown) {
      /* v8 ignore if -- requestJson never emits ONBOARDING_PENDING; pending responses set lastFailure without throwing. */
      if (error instanceof LlmError && error.code === 'ONBOARDING_PENDING') {
        lastFailure = error
      } else {
        throw error
      }
    }
    if (attempt + 1 < resolved.onboardingAttempts) await abortableDelay(resolved.onboardingDelayMs, signal)
  }
  throw new LlmError(
    `Antigravity onboarding did not complete after ${String(resolved.onboardingAttempts)} attempts`,
    'ONBOARDING_TIMEOUT',
    { cause: lastFailure },
  )
}

function callbackError(message: string, code = 'AUTH'): LlmError {
  return new LlmError(message, code)
}

async function startCallbackServer(
  host: string,
  requestedPort: number,
  path: string,
  expectedState: string,
): Promise<CallbackServer> {
  const server = createServer()
  const requestBase = host.includes(':') ? `http://[${host}]` : `http://${host}`
  /* v8 ignore next -- the Promise executor replaces this placeholder synchronously before request handlers are installed. */
  let resolveCallback: (result: CallbackCode) => void = () => undefined
  /* v8 ignore next -- the Promise executor replaces this placeholder synchronously before request handlers are installed. */
  let rejectCallback: (error: unknown) => void = () => undefined
  let settled = false
  const callback = new Promise<CallbackCode>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  const settle = (result: CallbackCode | undefined, error: unknown): void => {
    if (settled) return
    settled = true
    if (error !== undefined) rejectCallback(error)
    else {
      /* v8 ignore else -- each callback supplies either an error or a validated code and state. */
      if (result !== undefined) resolveCallback(result)
    }
  }
  server.on('request', (request, response) => {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    let requestUrl: URL
    try { requestUrl = new URL(/* v8 ignore next -- Node populates url on every parsed HTTP request. */ request.url ?? '/', requestBase) } catch {
      response.writeHead(400)
      response.end()
      return
    }
    if (requestUrl.pathname !== path) {
      response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h1>Not found</h1>')
      return
    }
    const error = nonEmptyString(requestUrl.searchParams.get('error'))
    const code = nonEmptyString(requestUrl.searchParams.get('code'))
    const state = nonEmptyString(requestUrl.searchParams.get('state'))
    if (state === undefined || state !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h1>Invalid OAuth callback</h1><p>You may close this window.</p>')
      // A stale tab or forged request must not consume the valid callback.
      return
    }
    if (error !== undefined) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h1>Google sign-in failed</h1><p>You may close this window.</p>')
      settle(undefined, callbackError('Antigravity OAuth consent was rejected'))
      return
    }
    if (code === undefined) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<h1>Missing OAuth callback values</h1>')
      settle(undefined, callbackError('Antigravity OAuth callback did not include code and state', 'INVALID_AUTH_RESPONSE'))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<h1>Sign-in complete</h1><p>You may close this window.</p>')
    settle({ code, state }, undefined)
  })
  const listening = new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(requestedPort, host, () => {
      server.removeListener('error', onError)
      const address = server.address()
      /* v8 ignore if -- the listening callback follows a successful TCP listen, which supplies an AddressInfo. */
      if (address === null || typeof address === 'string') {
        reject(new Error('Antigravity callback listener did not expose a TCP address'))
      } else {
        resolve(address.port)
      }
    })
  })
  let port: number
  try {
    port = await listening
  } catch (error: unknown) {
    server.close()
    throw new LlmError('Antigravity OAuth could not start its loopback listener', 'AUTH_LISTENER', { cause: error })
  }
  return { server, port, callback }
}

async function closeServer(server: Server): Promise<void> {
  /* v8 ignore next -- only this function closes a successfully started callback listener, once per login. */
  if (!server.listening) return
  server.closeIdleConnections()
  server.closeAllConnections()
  await new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })
}

function parseManualCallback(value: string, expectedState: string): string {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch (error: unknown) {
    throw new LlmError('Paste the complete Antigravity callback URL', 'INVALID_AUTH_RESPONSE', { cause: error })
  }
  const state = nonEmptyString(parsed.searchParams.get('state'))
  const code = nonEmptyString(parsed.searchParams.get('code'))
  if (state === undefined || state !== expectedState) {
    throw new LlmError('Antigravity OAuth state did not match this login attempt', 'AUTH_STATE_MISMATCH')
  }
  if (code === undefined) throw new LlmError('Antigravity callback URL did not include an authorization code', 'INVALID_AUTH_RESPONSE')
  return code
}

/**
 * Run the complete Antigravity login flow. The returned grant is ready for the
 * caller's credential store; this function never writes credentials itself.
 * @param interaction - login notices, prompts, and attempt cancellation.
 * @param options - transport, loopback callback, and onboarding configuration.
 * @returns the grant after token exchange and project provisioning.
 */
export async function loginAntigravity(
  interaction: AntigravityAuthorizationInteraction,
  options: AntigravityOAuthOptions = {},
): Promise<AntigravityCredentials> {
  const resolved = resolvedOptions(options)
  const initialAbort = abortError(interaction.signal)
  if (initialAbort !== undefined) throw initialAbort
  const pkce = createAntigravityPkce()
  const state = randomBytes(32).toString('base64url')
  const callbackServer = await startCallbackServer(
    resolved.callbackHost,
    resolved.callbackPort,
    resolved.callbackPath,
    state,
  )
  const startedAbort = abortError(interaction.signal)
  if (startedAbort !== undefined) {
    await closeServer(callbackServer.server)
    throw startedAbort
  }
  const redirectUri = antigravityCallbackUri(callbackServer.port, resolved.callbackPath)
  const authUrl = buildAntigravityAuthorizationUrl(state, redirectUri, pkce.challenge)
  const promptController = new AbortController()
  const abortPrompt = (): void => { promptController.abort(interaction.signal?.reason) }
  interaction.signal?.addEventListener('abort', abortPrompt, { once: true })
  /* v8 ignore next -- the cancellation Promise replaces this placeholder before it can be invoked. */
  let resolveCancellation: () => void = () => undefined
  try {
    interaction.notify({
      message: 'Open the Google sign-in page. If the browser cannot return here, paste the callback URL.',
      url: authUrl,
    })
    const manual = interaction.prompt({
      kind: 'secret',
      message: 'Paste the complete Antigravity OAuth callback URL after signing in.',
      placeholder: redirectUri,
      signal: promptController.signal,
    }).then(value => ({ kind: 'manual' as const, value }))
    const callback = callbackServer.callback.then(value => ({ kind: 'callback' as const, value }))
    const cancellation = new Promise<{ kind: 'cancelled' }>((resolve) => {
      resolveCancellation = () => { resolve({ kind: 'cancelled' }) }
    })
    interaction.signal?.addEventListener('abort', resolveCancellation, { once: true })
    if (interaction.signal?.aborted) resolveCancellation()
    const winner = await Promise.race([manual, callback, cancellation])
    let code: string
    if (winner.kind === 'callback') {
      promptController.abort('OAuth callback received')
      /* v8 ignore if -- startCallbackServer resolves only callbacks matching the same state. */
      if (winner.value.state !== state) {
        throw new LlmError('Antigravity OAuth state did not match this login attempt', 'AUTH_STATE_MISMATCH')
      }
      code = winner.value.code
    } else if (winner.kind === 'manual') {
      code = parseManualCallback(winner.value, state)
    } else {
      throw abortFailure(interaction.signal)
    }
    const token = await exchangeAntigravityCode(code, redirectUri, pkce.verifier, resolved, interaction.signal)
    const email = await fetchAntigravityUserInfo(token.access, resolved, interaction.signal)
    const projectId = await loadAntigravityProject(token.access, resolved, interaction.signal)
    return {
      access: token.access,
      refresh: token.refresh,
      expires: resolved.now() + token.expiresIn * 1000 - ANTIGRAVITY_TOKEN_SAFETY_MS,
      projectId,
      ...(email === undefined ? {} : { email }),
    }
  } catch (error: unknown) {
    if (interaction.signal?.aborted) throw abortFailure(interaction.signal)
    throw error
  } finally {
    interaction.signal?.removeEventListener('abort', abortPrompt)
    interaction.signal?.removeEventListener('abort', resolveCancellation)
    promptController.abort('OAuth login complete')
    await closeServer(callbackServer.server)
  }
}

/**
 * Generate an independent provider request id.
 * @returns a fresh UUID with the Antigravity request prefix.
 */
export function antigravityRequestId(): string {
  return `agent-${randomUUID()}`
}
