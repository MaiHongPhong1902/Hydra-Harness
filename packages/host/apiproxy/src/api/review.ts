/** Session-owned file review RPC methods. @module */
import type { SessionId } from '@hydra1902/harness-session/types'
import type { ChangeId, ReviewChange, ReviewMode, ReviewOutcome, WorkspaceReview } from '@hydra1902/harness-fs-review/client'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Review reads and actions; each mutation names the exact owning session and change. */
export interface ReviewApi {
  /** Read Git state from the session's recorded cwd; never accepts a client path or mutates Git. */
  workspace(
    request: RpcRequest<{ sessionId: SessionId; mode: ReviewMode; ref?: string; fullContext?: boolean }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<WorkspaceReview>>
  /** Read persisted history, optionally including runtime-owned child sessions. */
  list(request: RpcRequest<{ sessionId: SessionId; includeChildren?: boolean }>): Promise<RpcResponse<{ changes: ReviewChange[] }>>
  /** Mark an applied change kept without discarding its snapshot. */
  keep(request: RpcRequest<{ sessionId: SessionId; changeId: ChangeId }>): Promise<RpcResponse<ReviewOutcome>>
  /** Restore verified before bytes only when the workspace still matches the after hash. */
  undo(request: RpcRequest<{ sessionId: SessionId; changeId: ChangeId }>): Promise<RpcResponse<ReviewOutcome>>
}
