/** Provider discovery and a real, saved-configuration search probe for Settings. */

import type { WebSearchProviderDescriptor, SearchErrorCode } from '@hydra1902/harness-web'
import type { RpcRequest, RpcResponse } from './rpc.ts'

export type { WebSearchProviderDescriptor, SearchConfigField } from '@hydra1902/harness-web'

/** Safe probe result; upstream responses and credentials never cross this API. */
export type SearchConnectionResult =
  | { connected: true; provider: string; resultCount: number }
  | { connected: false; provider: string; code: SearchErrorCode; message: string; retryable: boolean }

/** Search configuration operations independent of model providers. */
export interface WebSearchApi {
  /** List implemented provider metadata, without resolving credentials. */
  providers(request: RpcRequest<{}>): Promise<RpcResponse<{ providers: WebSearchProviderDescriptor[] }>>
  /** Run a small search through the named provider's saved settings. */
  testConnection(request: RpcRequest<{ provider: string }>, signal?: AbortSignal): Promise<RpcResponse<SearchConnectionResult>>
}
