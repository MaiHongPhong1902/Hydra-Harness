/**
 * Custom-instructions editor state: load/save over `settings.readInstructions`
 * / `settings.writeInstructions`, with a distinct `conflict` status so the
 * section can offer a reload affordance instead of a plain retry.
 */

import { createSnapshotStore } from '@bosch/bh-client-runtime/client'
import type { SnapshotStore } from '@bosch/bh-client-runtime/client'
import type { IApiClient } from '@bosch/bh-api-remotes/client'

type InstructionsFace = Pick<IApiClient, 'settings'>

/** Editor lifecycle; `conflict` is distinct from `error` so the UI can offer reload instead of retry. */
export type InstructionsStatus = 'loading' | 'ready' | 'saving' | 'conflict' | 'error'

/** Custom-instructions editor snapshot. */
export interface InstructionsState {
  status: InstructionsStatus
  /** Current editor draft; diverges from `savedContent` while the user types. */
  draft: string
  /** Last content accepted from the Host (load or successful save). */
  savedContent: string
  /** SHA-256 content-hash revision of `savedContent`; undefined before the first load. */
  revision: string | undefined
  error: string | null
}

const INITIAL: InstructionsState = {
  status: 'loading',
  draft: '',
  savedContent: '',
  revision: undefined,
  error: null,
}

/** Loads, edits, and saves the personalization custom-instructions document. */
export class InstructionsController {
  /** Snapshot the renderer binds as `useInstructions`. */
  readonly store: SnapshotStore<InstructionsState> = createSnapshotStore(INITIAL)
  private disposed = false

  constructor(private readonly api: InstructionsFace) {}

  /** Read the current document from the Host, replacing any unsaved draft. */
  async load(): Promise<void> {
    this.store.update((draft) => { draft.status = 'loading'; draft.error = null })
    let response
    try {
      response = await this.api.settings.readInstructions({})
    } catch (error: unknown) {
      this.fail(error)
      return
    }
    if (this.disposed) return
    if (!response.result.ok) {
      this.fail(response.result.error.message)
      return
    }
    const { content, revision } = response.result.value
    this.store.update((draft) => {
      draft.status = 'ready'
      draft.draft = content
      draft.savedContent = content
      draft.revision = revision
      draft.error = null
    })
  }

  /**
   * Update the editor draft; does not write to the Host.
   * @param text - the draft text as the user last typed it.
   */
  setDraft(text: string): void {
    this.store.update((draft) => { draft.draft = text })
  }

  /** Write the current draft, fencing on the last-known revision. */
  async save(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.status === 'saving') return
    this.store.update((draft) => { draft.status = 'saving'; draft.error = null })
    let response
    try {
      response = await this.api.settings.writeInstructions({
        content: state.draft,
        ...state.revision === undefined ? {} : { expectedRevision: state.revision },
      })
    } catch (error: unknown) {
      this.fail(error)
      return
    }
    if (this.disposed) return
    if (!response.result.ok) {
      const { error } = response.result
      if (error.code === 'instructions-conflict') {
        this.store.update((draft) => { draft.status = 'conflict'; draft.error = error.message })
        return
      }
      this.fail(error.message)
      return
    }
    const { content, revision } = response.result.value
    this.store.update((draft) => {
      draft.status = 'ready'
      draft.draft = content
      draft.savedContent = content
      draft.revision = revision
      draft.error = null
    })
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.store.update((draft) => {
      draft.status = 'error'
      draft.error = error instanceof Error ? error.message : String(error)
    })
  }

  /** Stop accepting late responses after the owning fiber unloads. */
  dispose(): void {
    this.disposed = true
  }
}
