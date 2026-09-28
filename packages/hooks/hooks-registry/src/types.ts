/** Public types for the user-declared hook registry. */

import type {} from '@hydraharness/cordis'
import type { JsonValue } from '@hydraharness/harness-session/types'

/** Hook config dialect a record is written in, selecting its bridge. */
export type HookDialect = 'claude-code' | 'codex'

/** Where a record's hook definitions come from. */
export type HookSourceKind = 'file' | 'inline'

/**
 * Live state of one stored record. `invalid` is a stored record this registry
 * refuses to mount — an unreadable path, an unparseable document, or a
 * definition the dialect rejects — never a hook execution failure.
 */
export type HookRecordStatus = 'stopped' | 'started' | 'failed' | 'invalid'

/** One stored hook record as a configuration surface sees it. */
export interface HookRecordView {
  readonly name: string
  readonly dialect: HookDialect
  readonly source: HookSourceKind
  /** Desired state stored in the document, independent of {@link status}. */
  readonly enabled: boolean
  readonly status: HookRecordStatus
  /** Why a record is `invalid`, or the mount failure summary. */
  readonly detail?: string
  /** Absolute document path of a `file` record. */
  readonly configPath?: string
  /**
   * Event names the mounted definitions cover, in dialect spelling. Empty until
   * the record's definitions are read, and for a record this registry refuses.
   */
  readonly events: readonly string[]
  /** How many command hooks the definitions declare across every event. */
  readonly hookCount: number
  /** Substitution root a `claude-code` record supplies for `${CLAUDE_PLUGIN_ROOT}`. */
  readonly pluginRoot?: string
  /** Substitution root a `claude-code` record supplies for `${CLAUDE_PROJECT_DIR}`. */
  readonly projectDir?: string
}

/** Complete immutable projection returned by every registry operation. */
export interface HookRecordSnapshot {
  readonly records: readonly HookRecordView[]
}

/**
 * Complete definition of one hook record. A write replaces the named record
 * wholesale, so an omitted optional field clears the stored one. Exactly one of
 * `configPath` and `config` must be supplied.
 */
export interface HookRecordDefinitionRequest {
  /** Create requires an unused name; replace requires an existing record. */
  readonly mode: 'create' | 'replace'
  /** Stable record name; `[A-Za-z0-9_-]{1,64}`. */
  readonly name: string
  readonly dialect: HookDialect
  /** Absolute path to an existing hook document the harness reads as-is. */
  readonly configPath?: string
  /**
   * Hook definitions stored inline in the settings document: either a bare
   * event map or a `{ hooks: … }` wrapper, in the record's dialect. The registry
   * materializes them into a file for the bridge to read. Each dialect owns its
   * own document grammar, so the values stay lossless JSON rather than a shape
   * this package restates.
   */
  readonly config?: Readonly<Record<string, JsonValue>>
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` in `claude-code` commands. */
  readonly pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` in `claude-code` commands and env. */
  readonly projectDir?: string
  /** Default per-hook timeout in milliseconds when a hook declares none. */
  readonly defaultTimeoutMs?: number
  /** Desired state; a new record defaults to disabled. */
  readonly enabled?: boolean
}

/** Change one stored record's desired state without touching its definition. */
export interface HookRecordEnablementRequest {
  readonly name: string
  readonly enabled: boolean
}

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * The mounted bridge set now matches the stored records. Emitted after each
     * reconciliation settles — including the one at startup and the ones a
     * document change triggers — so an observer never reads the projection
     * between a committed record change and the mount that follows it.
     * @param snapshot - the projection as of this reconciliation.
     * @mode emit
     */
    'hooks-registry/reconciled'(snapshot: HookRecordSnapshot): void
  }
}
