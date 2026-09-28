/** Staged form for the page-memory Host settings namespace. */

import type { SettingsScope, SnapshotStore } from '@hydraharness/harness-client-runtime/client'
import { CardForm, numberField, textField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Host settings namespace owned by the page-memory plugin. */
export const PAGE_MEMORY_NS = 'page-memory'

/** Persisted page-memory settings shown in the Plugins section. */
export interface PageMemorySettings {
  role?: string
  locale?: string
  storageDir?: string
  maxRecordBytes?: number
  maxWorkflows?: number
  maxPages?: number
  maxContextBytes?: number
  maxObservations?: number
  maxHistory?: number
  verificationTimeoutMs?: number
}

/** State rendered by the page-memory card. */
export interface PageMemoryCardState extends CardShell {
  role: CardFieldState
  locale: CardFieldState
  storageDir: CardFieldState
  maxRecordBytes: CardFieldState
  maxWorkflows: CardFieldState
  maxPages: CardFieldState
  maxContextBytes: CardFieldState
  maxObservations: CardFieldState
  maxHistory: CardFieldState
  verificationTimeoutMs: CardFieldState
}

/** Registration-side face for the page-memory card. */
export interface PageMemoryCardFace extends CardActions {
  hooks: { pageMemoryCard: SnapshotStore<PageMemoryCardState> }
}

/** Bridges the Host settings scope onto the staged page-memory form. */
export class PageMemoryCardController {
  private readonly form: CardForm<PageMemorySettings>
  private readonly store: SnapshotStore<PageMemoryCardState>

  /** @param scope - the page-memory Host settings scope. */
  constructor(scope: SettingsScope<PageMemorySettings>) {
    this.form = new CardForm(scope, [
      textField('role'), textField('locale'), textField('storageDir'),
      numberField('maxRecordBytes'), numberField('maxWorkflows'), numberField('maxPages'),
      numberField('maxContextBytes'), numberField('maxObservations'), numberField('maxHistory'),
      numberField('verificationTimeoutMs'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  /** Release the settings subscription when the Plugins section unloads. */
  dispose(): void { this.form.dispose() }

  private projection(): PageMemoryCardState {
    return {
      ...this.form.shell(),
      role: this.form.field('role'), locale: this.form.field('locale'), storageDir: this.form.field('storageDir'),
      maxRecordBytes: this.form.field('maxRecordBytes'), maxWorkflows: this.form.field('maxWorkflows'),
      maxPages: this.form.field('maxPages'), maxContextBytes: this.form.field('maxContextBytes'),
      maxObservations: this.form.field('maxObservations'), maxHistory: this.form.field('maxHistory'),
      verificationTimeoutMs: this.form.field('verificationTimeoutMs'),
    }
  }

  /**
   * Build the card snapshot and staged form actions.
   * @returns the injected card face.
   */
  inject(): PageMemoryCardFace { return { hooks: { pageMemoryCard: this.store }, ...this.form.actions() } }
}
