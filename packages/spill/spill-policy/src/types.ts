/**
 * Vocabulary for the spill-policy plugin: the minimal structural view of a tool
 * execution the policy needs to derive the owning session for a spill artifact.
 *
 * `@hydraharness/harness-tools`' `ToolExecution` satisfies this shape, so the policy
 * reads `exec` straight through without importing `@hydraharness/harness-tools` or `@hydraharness/harness-agent`.
 * Only the session HEADER id is read — the same identity every other subsystem
 * keys off (see `@hydraharness/harness-tool-bash`'s owner derivation).
 *
 * @module @hydraharness/harness-spill-policy/types
 */

import type { SessionId } from '@hydraharness/harness-session'

/** Minimal structural view of a tool execution: the owning session's header id, when present. */
export interface SpillPolicyExec {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    session: {
      header: {
        /** The canonical session identity — the spill owner. */
        id: SessionId
      }
    }
  }
}
