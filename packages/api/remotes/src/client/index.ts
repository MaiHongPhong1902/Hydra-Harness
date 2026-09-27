/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@hydra1902/cordis'
import commandsRemote from '@hydra1902/harness-commands/remote'
import goalsRemote from '@hydra1902/harness-goal/remote'
import dynamicRemote from '@hydra1902/harness-cordis-host-runner/remote'
import fileReferencesRemote from '@hydra1902/harness-file-reference/remote'
import pluginInventoryRemote from '@hydra1902/harness-host-plugin-inventory/remote'
import messageFeedbackRemote from '@hydra1902/harness-message-feedback/remote'
import sessionReferencesRemote from '@hydra1902/harness-session-reference/remote'
import type { TypertClientRemote } from '@hydra1902/harness-typert-protocol'

export type { TypertClientRemote as ClientRemote } from '@hydra1902/harness-typert-protocol'
export type {
  AddPluginMarketplaceRequest,
  ImportedPluginEntry,
  ImportedPluginMcpServerEnablementRequest,
  ImportedPluginMcpToolApprovalRequest,
  ImportedPluginSnapshot,
  PluginImportSource,
  PluginEnablementResult,
  PluginInventorySnapshot,
  PluginMarketplaceSnapshot,
  SetPluginMarketplaceEnablementRequest,
} from '@hydra1902/harness-host-plugin-inventory/types'
// The user's own MCP and hook records: the inventory gateway publishes their
// Remotes, and each registry package owns the payload vocabulary.
export type {
  McpServerDefinitionRequest,
  McpServerEnablementRequest,
  McpServerSnapshot,
  McpServerStatus,
  McpServerTransport,
  McpServerView,
} from '@hydra1902/harness-mcp-registry/types'
export type {
  HookDialect,
  HookRecordDefinitionRequest,
  HookRecordEnablementRequest,
  HookRecordSnapshot,
  HookRecordStatus,
  HookRecordView,
  HookSourceKind,
} from '@hydra1902/harness-hooks-registry/types'
export type {} from '@hydra1902/harness-commands/remote'
export type {} from '@hydra1902/harness-file-reference/remote'
export type {} from '@hydra1902/harness-goal/remote'
export type {} from '@hydra1902/harness-host-plugin-inventory/remote'
export type {} from '@hydra1902/harness-message-feedback/remote'
export type {} from '@hydra1902/harness-session-reference/remote'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@hydra1902/harness-commands/types'
export type {} from '@hydra1902/harness-cordis-host-runner/types'
export type {} from '@hydra1902/harness-credentials/types'
export type {} from '@hydra1902/harness-authorization/types'
export type {} from '@hydra1902/harness-llm/types'
export type {} from '@hydra1902/harness-agent-presets/types'
export type {} from '@hydra1902/harness-settings/types'
export type {} from '@hydra1902/harness-skill/types'
export type {} from '@hydra1902/harness-fs-review/client'
export type { ReviewMode, WorkspaceReview, WorkspaceReviewFile } from '@hydra1902/harness-fs-review/client'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ClientResponse, ConfigurableProviderView, ConnectionHandle, ConnectionSinks, ContentBlock,
  CredentialView, DirectoryListing, DiscoveredModelView, HistoryEntry, HostFrame, IApiClient,
  AuthorizationAccountView, AuthorizationApi, AuthorizationAttemptView, AuthorizationEntryView,
  AuthorizationNoticeView, AuthorizationPromptView,
  AuthorizationUsageView,
  MessageId, ModelCatalogFailure, ModelProviderGroup, ModelReasoningEffort, ModelSelection,
  MuxFrame, PromptContentPart, QuestionResponsePayload, QueueAction, RpcError, RpcId, RpcReceipt,
  RpcRequest, RpcResponse, RpcResult, SessionId, SessionModels, SessionSearchItem,
  ConversationRevision, SessionSummary, SettingsNamespaceView, SettingsPathOpView, SkillEntry, StreamChunk,
  SubagentAddress, SubagentCatalog, JobView, ToolCallView, ToolEventView, ToolResultView,
  WorkspaceId, WorkspaceView,
} from '@hydra1902/harness-client-connection/client'
export type {} from '@hydra1902/harness-api-gateway/client'
export type {} from '@hydra1902/harness-cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@hydra1902/harness-cordis-host-runner/types'
// The JSON vocabulary those payloads are built from, re-exported for the same
// reason: a Client contribution names what it sends without importing a Host
// package, and this assembly is where both planes legitimately meet.
export type { JsonValue } from '@hydra1902/harness-session/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@hydra1902/harness-file-reference/types'
export type { SessionReferenceMentionCandidate } from '@hydra1902/harness-session-reference/types'

declare module '@hydra1902/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: TypertClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      commandsRemote, goalsRemote, dynamicRemote, fileReferencesRemote,
      pluginInventoryRemote, messageFeedbackRemote, sessionReferencesRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
