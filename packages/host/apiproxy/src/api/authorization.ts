/**
 * Host authorization API: a value-free view of provider login flows plus the
 * transient interaction needed to complete one login from a browser.
 */

import type {
  AuthorizationMethod,
  AuthorizationNotice,
  AuthorizationPromptOption,
  AuthorizationUsage,
} from '@hydraharness/harness-authorization/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Provider-owned identity label. The id is opaque and never a credential. */
export interface AuthorizationAccountView {
  id: string
  label: string
}

/** Provider usage view returned for one connected account. */
export type AuthorizationUsageView = AuthorizationUsage

/** One login flow and its value-free account inventory. */
export interface AuthorizationEntryView {
  key: string
  label: string
  methods: AuthorizationMethod[]
  inFlight: boolean
  accounts: AuthorizationAccountView[]
}

/** A transient notice from a running provider login. */
export type AuthorizationNoticeView = AuthorizationNotice

/** One pending prompt, with its opaque attempt-local id. */
export interface AuthorizationPromptView {
  id: string
  kind: 'text' | 'secret' | 'select'
  message: string
  placeholder?: string
  options?: AuthorizationPromptOption[]
}

/** State visible to the browser while one login runs. */
export interface AuthorizationAttemptView {
  id: string
  status: 'running' | 'authorized' | 'cancelled' | 'failed'
  notice?: AuthorizationNoticeView
  prompt?: AuthorizationPromptView
  error?: string
}

/** Authorization-domain unary methods. */
export interface AuthorizationApi {
  /** List registered flows and provider-owned account identities. */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ entries: AuthorizationEntryView[] }>>

  /** Start one flow and return an opaque id that can be polled. */
  begin(request: RpcRequest<{ key: string; method?: string }>, signal?: AbortSignal): Promise<RpcResponse<{ attemptId: string }>>

  /** Read the latest notice/prompt and terminal state for one attempt. */
  state(request: RpcRequest<{ attemptId: string }>): Promise<RpcResponse<{ attempt: AuthorizationAttemptView }>>

  /** Answer the currently pending prompt for one attempt. */
  answer(request: RpcRequest<{ attemptId: string; promptId: string; value: string }>): Promise<RpcResponse<{}>>

  /** Withdraw one running attempt. */
  cancel(request: RpcRequest<{ attemptId: string }>): Promise<RpcResponse<{}>>

  /** Remove one provider-owned account from a flow's credential pool. */
  logout(request: RpcRequest<{ key: string; accountId: string }>): Promise<RpcResponse<{}>>

  /** Fetch live provider usage for one connected account. */
  usage(
    request: RpcRequest<{ key: string; accountId: string }>, signal?: AbortSignal,
  ): Promise<RpcResponse<{ usage?: AuthorizationUsageView }>>
}
