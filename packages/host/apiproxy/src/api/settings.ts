/**
 * settings domain contract: the web face of the user-settings seam
 * (`ctx.settings`). Every payload that leaves this domain is redacted by the
 * seam (`describe({ redactSecrets: true })` semantics): `role('secret')`
 * fields never ride a response in any layer, and the `secrets` slot list is
 * how a form learns a write-only field exists and whether it is configured.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One schema-declared secret slot inside a redacted namespace value. */
export interface SettingsSecretView {
  /** Path from the section root to the removed field. */
  path: string[]
  /** Whether the slot currently holds a value (the value itself never rides). */
  set: boolean
}

/** Wire view of one registered settings namespace. */
export interface SettingsNamespaceView {
  /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
  ns: string
  /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
  schema: unknown
  /** Redacted resolved value (schema defaults → composition base → user layer). */
  value: unknown
  /** Redacted composition base layer, when the registrant declared one. */
  base?: unknown
  /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
  user?: unknown
  /** When the owner applies changes. */
  applies: 'live' | 'restart'
  /** Every schema-declared secret slot with its configured state. */
  secrets: SettingsSecretView[]
  /**
   * Monotonic revision of the raw user section this view was read at. Send it
   * back as `expectedRevision` on a write so a stale editor is refused rather
   * than silently overwriting a concurrent change.
   */
  revision: number
}

/**
 * One path-addressed edit carried by `settings.mutate`. `set` writes the
 * value at the path (creating intermediate objects); `unset` removes it. The
 * empty path addresses the section root.
 */
export type SettingsPathOpView =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/**
 * The personalization custom-instructions document (`$BH_HOME/AGENTS.md`,
 * the same fixed user-global file `@bosch/bh-agent-instructions` discovers).
 */
export interface InstructionsDocumentView {
  /** Raw file content; the empty string when the file does not exist yet. */
  content: string
  /**
   * SHA-256 hex digest of the raw UTF-8 bytes this view reflects. Send it
   * back as `expectedRevision` on a write so a stale editor is refused
   * rather than silently overwriting a concurrent change.
   */
  revision: string
}

/** One private local-memory entry surfaced only to the loopback settings page. */
export interface MemoryEntryView {
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

/** Settings-domain unary methods (the map keys settings.* of RpcMethodMap). */
export interface SettingsApi {
  /**
   * Describe every registered namespace: redacted layered values plus the
   * serialized schema a client renders its form from. `hasDocument` reports
   * whether a file-backed provider owns a local document without exposing its
   * Host path. This method is loopback-only; `writable: false` (read-only
   * provider) tells the client to disable every write control.
   */
  describe(request: RpcRequest<{}>): Promise<RpcResponse<{
    writable: boolean
    hasDocument: boolean
    namespaces: SettingsNamespaceView[]
  }>>

  /**
   * Materialize the configured local document when absent and ask the Host to
   * hand it to the platform text-document opener. macOS forces a text editor;
   * Linux and Windows use the desktop file association. The request carries
   * no path, so the browser cannot choose an arbitrary Host filesystem target.
   */
  openDocument(
    request: RpcRequest<{}>, signal: AbortSignal,
  ): Promise<RpcResponse<{ opened: true }>>

  /**
   * Merge a patch into one namespace's user layer (validate → persist →
   * commit). Secret-role fields may be INCLUDED in the patch (write-only
   * direction); a form that leaves a secret untouched simply omits it and the
   * merge preserves the stored value. Responds with the namespace's new
   * redacted view; a schema or storage rejection is `settings-rejected`.
   */
  update(request: RpcRequest<{ ns: string; patch: object; expectedRevision?: number }>): Promise<RpcResponse<SettingsNamespaceView>>

  /**
   * Replace one namespace's user section wholesale — the removal/reset path a
   * merge cannot express (`section: {}` resets to composition defaults). Keys
   * absent from `section` are dropped, secrets included: a client must first
   * fold the descriptor's `user` layer (and re-supply any secret it wants to
   * keep) or accept the reset.
   */
  replace(request: RpcRequest<{ ns: string; section: object; expectedRevision?: number }>): Promise<RpcResponse<SettingsNamespaceView>>

  /**
   * Apply path-addressed edits to one namespace's user section, resolved
   * against the section as stored — NOT against whatever the caller last
   * read. This is the removal path for any client holding the redacted
   * descriptor: it names the field it means, so a secret the wire never
   * returned cannot be deleted as a side effect. `replace` remains the
   * deliberate wholesale reset.
   */
  mutate(
    request: RpcRequest<{ ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }>,
  ): Promise<RpcResponse<SettingsNamespaceView>>

  /**
   * Read the personalization custom-instructions document. This method is
   * loopback-only. Absent file content reads as the empty string, never a
   * missing-service error — there is no provider to be absent.
   */
  readInstructions(request: RpcRequest<{}>): Promise<RpcResponse<InstructionsDocumentView>>

  /**
   * Replace the personalization custom-instructions document wholesale, under
   * a cross-process write lock. `expectedRevision`, when carried, must match
   * the file's current content hash or the write is refused as
   * `instructions-conflict`; omit it to write unconditionally. Content over
   * 65,536 raw UTF-8 bytes is refused as `instructions-rejected`. This method
   * is loopback-only.
   */
  writeInstructions(
    request: RpcRequest<{ content: string; expectedRevision?: string }>,
  ): Promise<RpcResponse<InstructionsDocumentView>>

  /** List memories held in the local BH-home memory file. */
  listMemories(request: RpcRequest<{}>): Promise<RpcResponse<{ entries: MemoryEntryView[] }>>

  /** Delete one memory by its opaque local id. */
  removeMemory(request: RpcRequest<{ id: string }>): Promise<RpcResponse<{ removed: boolean }>>
}
