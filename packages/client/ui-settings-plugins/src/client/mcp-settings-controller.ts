/** Obsidian MCP settings and credential state for the Plugins MCP tab. */

import type { IApiClient } from '@hydra1902/harness-client-connection/client'
import type { SettingsScope, SnapshotStore } from '@hydra1902/harness-client-runtime/client'
import {
  CardForm,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Settings namespace registered by the Obsidian knowledge plugin. */
export const MCP_SETTINGS_NS = 'obsidian-knowledge'

/** Credential reference resolved by the Obsidian MCP client. */
export const MCP_API_KEY_REF = 'OBSIDIAN_API_KEY'

const API_KEY_FIELD = 'apiKey'

/** User-editable Obsidian knowledge settings; the section carries no fields. */
export type McpSettings = Record<string, unknown>

/** State rendered by the MCP settings tab. */
export interface McpSettingsState extends CardShell {
  /** Staged write-only MCP credential. */
  apiKey: CardFieldState
  /** Whether the Host resolves the MCP credential. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write. */
  apiKeyWritable: boolean
}

/** Registration-side face injected into the MCP tab. */
export interface McpSettingsFace extends CardActions {
  hooks: {
    /** MCP tab snapshot bound by the renderer as useMcpSettings. */
    mcpSettings: SnapshotStore<McpSettingsState>
  }
}

/** Bridges Obsidian settings and its fixed credential reference onto one tab. */
export class McpSettingsController {
  private readonly form: CardForm<McpSettings>
  private readonly store: SnapshotStore<McpSettingsState>
  private credential = { configured: false, writable: true }

  /**
   * @param scope - bound `obsidian-knowledge` settings scope.
   * @param api - credentials wire face.
   */
  constructor(
    scope: SettingsScope<McpSettings>,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.form = new CardForm(
      scope,
      [],
      [{ field: API_KEY_FIELD, write: text => this.writeKey(text) }],
    )
    this.store = this.form.bind(() => this.projection())
    void this.readCredential()
  }

  /**
   * Re-read the badge when another surface changes the Obsidian key.
   * @param ref - credential reference that changed.
   */
  refreshCredential(ref: string): void {
    if (ref === MCP_API_KEY_REF) void this.readCredential()
  }

  /**
   * Build the tab's injected state and actions.
   * @returns MCP settings face.
   */
  inject(): McpSettingsFace {
    return { hooks: { mcpSettings: this.store }, ...this.form.actions() }
  }

  private projection(): McpSettingsState {
    return {
      ...this.form.shell(),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
    }
  }

  private async readCredential(): Promise<void> {
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [MCP_API_KEY_REF] })
    } catch (_credentialReadFailure) {
      return
    }
    if (!response.result.ok) return
    const view = response.result.value.credentials[MCP_API_KEY_REF]
    const next = { configured: view?.configured ?? false, writable: view?.writable ?? true }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  private async writeKey(value: string): Promise<boolean> {
    let accepted = false
    try {
      const response = await this.api.credentials.set({ ref: MCP_API_KEY_REF, value })
      accepted = response.result.ok
    } catch (_credentialWriteFailure) {
      // No acknowledgement: keep the draft even if an older key exists.
    }
    await this.readCredential()
    return accepted
  }
}
