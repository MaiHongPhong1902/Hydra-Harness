/** Durable account pools and request-local account selection. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import type {
  AuthContext,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai'
import type { Context } from '@hydra/cordis'
import {
  authorizationAccountId,
  type AuthorizationAccount,
  type AuthorizationAccountId,
  type AuthorizationAccounts,
} from '@hydra/harness-authorization'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@hydra/harness-credentials'
import { LlmError } from '@hydra/harness-llm'
import type { StreamChunk } from '@hydra/harness-llm'

/** Current durable account-pool record version. */
export const ACCOUNT_POOL_VERSION = 1

/** One account entry in the canonical stored payload. */
export interface AccountGrant {
  /** Opaque provider-owned account identity. */
  id: AuthorizationAccountId
  /** User-facing account label. */
  label: string
  /** Provider credential; never returned by {@link AccountPool.list}. */
  credential: Credential
}

/** Canonical payload stored in one provider's grant record. */
export interface AccountPoolPayload {
  /** Canonical payload version. */
  version: typeof ACCOUNT_POOL_VERSION
  /** Provider accounts in stable persisted order. */
  accounts: AccountGrant[]
}

/** Account order and credential scope used by one account-backed adapter. */
export interface AccountPoolSelector {
  /** Return a request-local round-robin order of opaque account identities. */
  ordered(providerId: string): Promise<readonly { id: string }[]>
  /** Consume one stream while the credential store sees the selected account. */
  stream(
    providerId: string,
    accountId: string,
    source: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk>
}

/** A pool's public operations plus its pi-ai credential adapter. */
export interface AccountPool {
  /** Credential record key owned by this provider route. */
  readonly key: CredentialKey
  /** Store used by pi-ai login, refresh, and request auth resolution. */
  readonly credentials: CredentialStore
  /** Account inventory exposed through AuthorizationService. */
  readonly accounts: AuthorizationAccounts
  /** Request-local round-robin selection and account context. */
  readonly selector: AccountPoolSelector
  /**
   * Add or refresh one account under the credentials modify lock.
   * @param label - optional explicit label; undefined derives one from the credential.
   * @param credential - provider credential to store.
   * @param signal - cancellation for the durable write.
   * @returns the stored account identity and label.
   */
  add(label: string | undefined, credential: Credential, signal?: AbortSignal): Promise<AuthorizationAccount>
  /** Run an operation whose unscoped store write adds an account with this label. */
  withLoginLabel<T>(label: string, operation: () => Promise<T>): Promise<T>
  /** Run an operation whose credential reads and writes address one account. */
  withAccount<T>(id: AuthorizationAccountId | string, operation: () => Promise<T>): Promise<T>
}

/** Inputs required to create one provider's account pool. */
export interface AccountStoreOptions {
  /** Context whose credential provider owns the durable grant record. */
  ctx: Context
  /** Grant record key for this provider. */
  key: CredentialKey
  /** pi-ai provider id resolved by this pool's credential adapter. */
  providerId: string
  /** Label used when a provider login supplies no account label. */
  providerLabel: string
}

const MAX_ACCOUNT_ID = 256
const MAX_ACCOUNT_LABEL = 512

/** Minimal auth context for provider implementations that use OAuth only. */
export const emptyAuthContext: AuthContext = {
  env: () => Promise.resolve(undefined),
  fileExists: () => Promise.resolve(false),
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function cloneCredential(value: Credential): Credential {
  return structuredClone(value)
}

function accountId(value: unknown): AuthorizationAccountId | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ACCOUNT_ID) return undefined
  return authorizationAccountId(value)
}

function accountLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ACCOUNT_LABEL ? value : undefined
}

function credential(value: unknown): Credential | undefined {
  const record = objectRecord(value)
  if (record === undefined || (record.type !== 'oauth' && record.type !== 'api_key')) return undefined
  if (record.type === 'oauth'
    && (typeof record.access !== 'string' || record.access.length === 0
      || typeof record.refresh !== 'string' || record.refresh.length === 0
      || typeof record.expires !== 'number' || !Number.isFinite(record.expires))) return undefined
  if (record.type === 'api_key'
    && record.key !== undefined && (typeof record.key !== 'string' || record.key.length === 0)) return undefined
  if (record.type === 'api_key' && record.env !== undefined) {
    const env = objectRecord(record.env)
    if (env === undefined || Object.values(env).some(value => typeof value !== 'string')) return undefined
  }
  try {
    return cloneCredential(record as Credential)
  } catch {
    return undefined
  }
}

/**
 * Parse the opaque credentials record into the account payload this package owns.
 * @param record - stored account-pool record, or `undefined` when absent.
 * @param key - diagnostic key displayed when the record is malformed.
 * @returns the validated account-pool payload.
 */
export function parseAccountPool(record: CredentialRecord | undefined, key = 'account pool'): AccountPoolPayload {
  if (record === undefined) return { version: ACCOUNT_POOL_VERSION, accounts: [] }
  if (record.kind !== 'grant') throw new Error(`llm-account-auth: ${key} must be a grant record`)
  const payload = objectRecord(record.payload)
  if (payload === undefined || payload.version !== ACCOUNT_POOL_VERSION || !Array.isArray(payload.accounts)) {
    throw new Error(`llm-account-auth: ${key} has an invalid account-pool payload`)
  }
  const seen = new Set<string>()
  const accounts: AccountGrant[] = []
  for (const candidate of payload.accounts) {
    const entry = objectRecord(candidate)
    const id = accountId(entry?.id)
    const label = accountLabel(entry?.label)
    const storedCredential = credential(entry?.credential)
    if (entry === undefined || id === undefined || label === undefined || storedCredential === undefined) {
      throw new Error(`llm-account-auth: ${key} contains an invalid account entry`)
    }
    if (seen.has(id)) throw new Error(`llm-account-auth: ${key} contains duplicate account ids`)
    seen.add(id)
    accounts.push({ id, label, credential: storedCredential })
  }
  return { version: ACCOUNT_POOL_VERSION, accounts }
}

function recordOf(pool: AccountPoolPayload): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      version: ACCOUNT_POOL_VERSION,
      accounts: pool.accounts.map(account => ({
        id: account.id,
        label: account.label,
        credential: cloneCredential(account.credential),
      })),
    },
  }
}

function jwtPayload(access: string): Record<string, unknown> | undefined {
  const segment = access.split('.')[1]
  if (segment === undefined) return undefined
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - segment.length % 4) % 4)
    const decoded = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('utf8')
    return objectRecord(JSON.parse(decoded))
  } catch {
    return undefined
  }
}

function firstAccountId(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const id = accountId(value)
    if (id !== undefined) return id
  }
  return undefined
}

function combinedIdentity(first: string, second: string): AuthorizationAccountId {
  const combined = `${first}:${second}`
  return authorizationAccountId(combined.length <= MAX_ACCOUNT_ID
    ? combined
    : createHash('sha256').update(JSON.stringify([first, second])).digest('hex'))
}

/**
 * Derive a stable identity from the provider's account, workspace, and user
 * claims. ChatGPT's account claim may identify a shared workspace, so a user
 * claim is included when the token exposes one; a plain account claim remains
 * the fallback for providers that do not expose a separate user identity.
 */
function identityOf(credential: Credential): AuthorizationAccountId | undefined {
  const record = credential as Credential & Record<string, unknown>
  const claims = credential.type === 'oauth' ? jwtPayload(credential.access) : undefined
  const authClaims = objectRecord(claims?.['https://api.openai.com/auth'])
  const account = firstAccountId([
    record.accountId,
    record.account_id,
    record.chatgptAccountId,
    record.chatgpt_account_id,
    authClaims?.chatgpt_account_id,
    claims?.chatgpt_account_id,
  ])
  const workspace = firstAccountId([
    record.workspaceId,
    record.workspace_id,
    record.organizationId,
    record.organization_id,
    record.orgId,
    record.org_id,
    authClaims?.workspace_id,
    authClaims?.organization_id,
    claims?.workspace_id,
    claims?.organization_id,
  ])
  const user = firstAccountId([
    record.userId,
    record.user_id,
    record.chatgptUserId,
    record.chatgpt_user_id,
    authClaims?.chatgpt_user_id,
    claims?.user_id,
    claims?.sub,
  ])
  if (account !== undefined && user !== undefined) return combinedIdentity(account, user)
  if (workspace !== undefined && user !== undefined) return combinedIdentity(workspace, user)
  if (account !== undefined) return authorizationAccountId(account)
  if (workspace !== undefined) return authorizationAccountId(workspace)
  if (user !== undefined) return authorizationAccountId(user)
  for (const field of ['email', 'emailAddress', 'id']) {
    const id = accountId(record[field])
    if (id !== undefined) return authorizationAccountId(id)
  }
  return undefined
}

function labelOf(providerLabel: string, credential: Credential, index: number): string {
  const record = credential as Credential & Record<string, unknown>
  const claims = credential.type === 'oauth' ? jwtPayload(credential.access) : undefined
  const authClaims = objectRecord(claims?.['https://api.openai.com/auth'])
  const profileClaims = objectRecord(claims?.['https://api.openai.com/profile'])
  for (const field of ['email', 'emailAddress', 'name', 'preferred_username']) {
    const label = accountLabel(record[field])
    if (label !== undefined) return label
  }
  for (const field of ['email', 'emailAddress', 'name', 'preferred_username']) {
    const label = accountLabel(profileClaims?.[field])
    if (label !== undefined) return label
  }
  for (const field of ['email', 'emailAddress', 'name', 'preferred_username']) {
    const label = accountLabel(claims?.[field])
    if (label !== undefined) return label
  }
  for (const field of ['email', 'emailAddress', 'name', 'preferred_username']) {
    const label = accountLabel(authClaims?.[field])
    if (label !== undefined) return label
  }
  for (const field of ['accountId', 'userId']) {
    const label = accountLabel(record[field])
    if (label !== undefined) return label
  }
  for (const field of ['accountId', 'userId', 'sub']) {
    const label = accountLabel(claims?.[field])
    if (label !== undefined) return label
  }
  for (const field of ['accountId', 'userId', 'chatgpt_account_id', 'chatgpt_user_id', 'sub']) {
    const label = accountLabel(authClaims?.[field])
    if (label !== undefined) return label
  }
  return `${providerLabel} account ${String(index + 1)}`
}

/**
 * Build the pool, store, authorization operations, and selector for one route.
 *
 * The credential provider is read through `ctx.get()` on every operation so a
 * service replacement is observed immediately. Writes are delegated to its
 * serialized record modifier, including pi-ai refreshes and logout.
 * @param options - context, record key, provider id, and display label.
 * @returns the value-free account operations and pi-ai adapters.
 * @throws {LlmError} code `NO_CREDENTIAL_STORE` when the credential service is absent during an operation.
 */
export function createAccountPool(options: AccountStoreOptions): AccountPool {
  const { ctx, key, providerId, providerLabel } = options
  const selected = new AsyncLocalStorage<AuthorizationAccountId>()
  const loginLabels = new AsyncLocalStorage<string>()
  let cursor = 0

  const requiredCredentials = () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      throw new LlmError('llm-account-auth requires the credentials service', 'NO_CREDENTIAL_STORE')
    }
    return credentials
  }

  const read = async (): Promise<AccountPoolPayload> => parseAccountPool(
    await requiredCredentials().readRecord(key), key,
  )

  const mutate = async (
    operation: (pool: AccountPoolPayload) => AccountPoolPayload | undefined | Promise<AccountPoolPayload | undefined>,
  ): Promise<AccountPoolPayload> => {
    const credentials = requiredCredentials()
    const stored = await credentials.modifyRecord(key, async (current) => {
      const next = await operation(parseAccountPool(current, key))
      return next === undefined ? undefined : recordOf(next)
    })
    return parseAccountPool(stored, key)
  }

  const add = async (label: string | undefined, value: Credential, signal?: AbortSignal): Promise<AuthorizationAccount> => {
    const explicitLabel = label === undefined ? undefined : accountLabel(label.trim())
    let result: AuthorizationAccount | undefined
    await mutate((pool) => {
      if (signal?.aborted) {
        throw new LlmError('account login was aborted before its credential was stored', 'ABORTED', {
          cause: signal.reason,
        })
      }
      const known = identityOf(value)
      const existing = known === undefined ? undefined : pool.accounts.find(account => account.id === known)
      const id = existing?.id ?? known ?? authorizationAccountId(randomUUID())
      const index = existing === undefined ? pool.accounts.length : pool.accounts.indexOf(existing)
      const checkedLabel = explicitLabel ?? labelOf(providerLabel, value, index)
      const next: AccountGrant = {
        id,
        label: checkedLabel,
        credential: cloneCredential(value),
      }
      const accounts = existing === undefined
        ? [...pool.accounts, next]
        : pool.accounts.map((account, position) => position === index ? next : account)
      result = { id, label: checkedLabel }
      return { version: ACCOUNT_POOL_VERSION, accounts }
    })
    if (result === undefined) throw new Error('llm-account-auth: account write did not commit')
    return result
  }

  const store: CredentialStore = {
    async read(id): Promise<Credential | undefined> {
      if (id !== providerId) return undefined
      const pool = await read()
      const selectedId = selected.getStore()
      const entry = selectedId === undefined
        ? undefined
        : pool.accounts.find(account => account.id === selectedId)
      return entry === undefined ? undefined : cloneCredential(entry.credential)
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const pool = await read()
      const first = pool.accounts[0]
      return first === undefined ? [] : [{ providerId, type: first.credential.type }]
    },
    async modify(id, callback): Promise<Credential | undefined> {
      if (id !== providerId) return callback(undefined)
      let updated: Credential | undefined
      await mutate(async (pool) => {
        const selectedId = selected.getStore()
        const existing = selectedId === undefined
          ? undefined
          : pool.accounts.find(account => account.id === selectedId)
        if (selectedId !== undefined && existing === undefined) {
          throw new LlmError(`account "${selectedId}" is no longer connected`, 'ACCOUNT_GONE')
        }
        const next = await callback(existing === undefined ? undefined : cloneCredential(existing.credential))
        if (next === undefined) return undefined
        if (existing !== undefined) {
          updated = cloneCredential(next)
          return {
            version: ACCOUNT_POOL_VERSION,
            accounts: pool.accounts.map(account => account.id === existing.id
              ? { ...account, credential: cloneCredential(next) }
              : account),
          }
        }
        const label = loginLabels.getStore() ?? labelOf(providerLabel, next, pool.accounts.length)
        const idValue = identityOf(next) ?? authorizationAccountId(randomUUID())
        const duplicate = pool.accounts.find(account => account.id === idValue)
        if (duplicate !== undefined) {
          updated = cloneCredential(next)
          return {
            version: ACCOUNT_POOL_VERSION,
            accounts: pool.accounts.map(account => account.id === duplicate.id
              ? { ...account, label, credential: cloneCredential(next) }
              : account),
          }
        }
        updated = cloneCredential(next)
        return {
          version: ACCOUNT_POOL_VERSION,
          accounts: [...pool.accounts, { id: idValue, label, credential: cloneCredential(next) }],
        }
      })
      return updated
    },
    async delete(id): Promise<void> {
      if (id !== providerId) return
      const selectedId = selected.getStore()
      await mutate(pool => selectedId === undefined
        ? { version: ACCOUNT_POOL_VERSION, accounts: [] }
        : {
          version: ACCOUNT_POOL_VERSION,
          accounts: pool.accounts.filter(account => account.id !== selectedId),
        })
    },
  }

  const accounts: AuthorizationAccounts = {
    async list(): Promise<readonly AuthorizationAccount[]> {
      return (await read()).accounts.map(({ id, label }) => ({ id, label }))
    },
    async remove(id: AuthorizationAccountId): Promise<void> {
      await mutate((pool) => {
        if (!pool.accounts.some(account => account.id === id)) {
          throw new LlmError(`account "${id}" is not connected`, 'ACCOUNT_GONE')
        }
        return {
          version: ACCOUNT_POOL_VERSION,
          accounts: pool.accounts.filter(account => account.id !== id),
        }
      })
    },
  }

  const selector: AccountPoolSelector = {
    async ordered(id): Promise<readonly { id: string }[]> {
      if (id !== providerId) return []
      const current = (await read()).accounts
      if (current.length === 0) return []
      const start = cursor % current.length
      cursor = (start + 1) % current.length
      return [...current.slice(start), ...current.slice(0, start)].map(account => ({ id: account.id }))
    },
    async *stream(id, account, source): AsyncIterable<StreamChunk> {
      if (id !== providerId) throw new LlmError(`unknown account provider "${id}"`, 'ACCOUNT_PROVIDER')
      const accountId = authorizationAccountId(account)
      const iterator = selected.run(accountId, () => source())[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const next = await selected.run(accountId, () => iterator.next())
          if (next.done) {
            exhausted = true
            return
          }
          yield next.value
        }
      } finally {
        if (!exhausted && iterator.return !== undefined) {
          try {
            await selected.run(accountId, () => iterator.return?.())
          } catch {
            // The consumer's stop owns the outcome; cleanup errors cannot
            // resurrect a failed account attempt or mask cancellation.
          }
        }
      }
    },
  }

  return {
    key,
    credentials: store,
    accounts,
    selector,
    add,
    withLoginLabel: (label, operation) => loginLabels.run(label.trim(), operation),
    withAccount: (id, operation) => selected.run(authorizationAccountId(id), operation),
  }
}

/**
 * Build the record key used by both account flows and request adapters.
 * @param provider - provider route owned by this account pool.
 * @returns the provider's credential-record key.
 */
export function accountRecordKey(provider: string): CredentialKey {
  return credentialKey('llm-account-auth', provider)
}
