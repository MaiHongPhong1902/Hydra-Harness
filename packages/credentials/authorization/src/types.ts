/**
 * Wire-safe authorization types, free of cordis/service imports so browser type
 * chains (apiproxy api → client) can consume them without loading this
 * package's Context augmentation.
 * @module @hydraharness/harness-authorization/types
 */

import type { CredentialKey } from '@hydraharness/harness-credentials/types'
import type { Branded } from '@hydraharness/harness-brand'

/** One way a flow can obtain its credential, named by the flow that offers it. */
export interface AuthorizationMethod {
  /** Flow-owned identifier, echoed back when a caller picks this method. */
  id: string
  /** User-facing label for a picker. */
  label: string
}

/** A running flow's report to whoever is watching it. Never carries a secret. */
export interface AuthorizationNotice {
  /** What is happening, or what the human must do next. */
  message: string
  /** A page the human must open to continue. */
  url?: string
  /** A short code the human must enter on that page. */
  code?: string
}

/** One choice offered by a `select` prompt. */
export interface AuthorizationPromptOption {
  /** Value returned when this option is chosen. */
  id: string
  /** User-facing label. */
  label: string
  /** Optional extra context rendered by capable surfaces. */
  description?: string
}

/**
 * A question a flow must have answered before it can continue. `secret` differs
 * from `text` only in presentation — a surface masks it and keeps it out of
 * logs — and `select` answers with the chosen option's `id`.
 */
export type AuthorizationPrompt = {
  /**
   * Withdraws this prompt alone, leaving the flow running. A flow that races a
   * typed code against a browser callback aborts the losing prompt here; the
   * whole authorization is cancelled through the request's signal instead.
   */
  signal?: AbortSignal
} & ({
  kind: 'text'
  message: string
  placeholder?: string
} | {
  kind: 'secret'
  message: string
  placeholder?: string
} | {
  kind: 'select'
  message: string
  options: readonly AuthorizationPromptOption[]
})

/** Opaque account identity within its owning authorization flow. */
export type AuthorizationAccountId = Branded<'AuthorizationAccountId'>

/** One provider-owned account identity, safe to show in a configuration surface. */
export interface AuthorizationAccount {
  /** Opaque provider-owned account id; this value never contains a token. */
  id: AuthorizationAccountId
  /** Human-readable label for the account. */
  label: string
}

/** One provider-reported rate-limit window. Percentages are used values. */
export interface AuthorizationUsageWindow {
  /** Provider feature or model whose allowance this measures. */
  name: string
  /** Provider grouping for this allowance when the provider supplies one. */
  group?: string
  /** Provider's raw window label when it supplies one. */
  window?: string
  /** Provider description for this allowance when it supplies one. */
  description?: string
  /** Provider window duration in minutes when supplied. */
  windowMinutes?: number
  /** Percentage consumed in this window. */
  usedPercent: number
  /** Remaining request or token count when the provider supplies one. */
  remainingAmount?: number
  /** Whether the provider marks this allowance as disabled. */
  disabled?: boolean
  /** Unix timestamp at which this window resets. */
  resetsAt?: number
}

/** One provider-reported AI credit balance attached to a subscription tier. */
export interface AuthorizationUsageCredits {
  /** Tier that owns this balance in the provider response. */
  tier: 'current' | 'paid' | 'g1'
  /** Provider credit enum when supplied. */
  creditType?: string
  /** Remaining credit amount. */
  creditAmount?: number
  /** Minimum amount required before credit usage is allowed. */
  minimumCreditAmountForUsage?: number
}

/** Provider-reported usage for one connected account. */
export interface AuthorizationUsage {
  /** Provider subscription or account tier. */
  planType?: string
  /** Only windows supplied by the provider; an empty list means unreported. */
  limits: AuthorizationUsageWindow[]
  /** Number of banked resets currently available. */
  bankedResetCount?: number
  /** Provider-reported credit balances; absent when the provider omits them. */
  credits?: AuthorizationUsageCredits[]
  /** Unix timestamp in seconds when this report was fetched successfully. */
  fetchedAt: number
}

/** Account inventory and removal operations owned by an authorization flow. */
export interface AuthorizationAccounts {
  /**
   * List account identities without returning credential payloads.
   * @returns the current provider-owned accounts.
   */
  list(): Promise<readonly AuthorizationAccount[]>
  /**
   * Remove one provider-owned account.
   * @param id - the opaque account id returned by {@link list}.
   */
  remove(id: AuthorizationAccountId): Promise<void>
  /**
   * Fetch usage from the provider without returning credentials.
   * @param id - connected account identity.
   * @param signal - cancellation for refresh and provider requests.
   * @returns reported usage, or undefined when unsupported.
   */
  usage?(id: AuthorizationAccountId, signal?: AbortSignal): Promise<AuthorizationUsage | undefined>
}

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * One authorization attempt has finished and released its key. The event
     * carries no credential value, so remote configuration surfaces may use it
     * to refresh account state.
     * @param key - the credential flow key whose attempt finished.
     * @param settlement - the public terminal outcome.
     * @mode emit
     */
    'authorization/settled'(key: CredentialKey, settlement: AuthorizationSettlement): void
  }
}

/** How one authorization attempt ended, as its own caller sees it. */
export type AuthorizationStatus = 'authorized' | 'cancelled'

/**
 * How one attempt ended, as an onlooker sees it. A failure reaches its caller
 * as a thrown error rather than an outcome, so `failed` exists only here — on
 * the event stream, where a watcher that did not start the attempt has no
 * other way to tell a refusal from a breakage.
 */
export type AuthorizationSettlement = AuthorizationStatus | 'failed'

/** The result of one `begin()` attempt. */
export interface AuthorizationOutcome {
  /** `authorized` once the record is committed and observed; `cancelled` when the human or caller withdrew. */
  status: AuthorizationStatus
}

/** A registered flow as a surface sees it: what it authorizes and whether it is busy. */
export interface AuthorizationEntry {
  /** The credential record this flow writes. */
  key: CredentialKey
  /** User-facing name of what is being authorized. */
  label: string
  /** The methods this flow offers, most preferred first. */
  methods: readonly AuthorizationMethod[]
  /** Whether an attempt for this key is running right now. */
  inFlight: boolean
}
