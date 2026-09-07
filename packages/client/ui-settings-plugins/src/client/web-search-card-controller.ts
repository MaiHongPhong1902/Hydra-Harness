/** Saved provider selection with independent, retained provider and credential drafts. */

import type { IApiClient } from '@hydra/harness-client-connection/client'
import type { SettingsScope, SnapshotStore } from '@hydra/harness-client-runtime/client'
import type { SearchConfigField, WebSearchProviderDescriptor } from '@hydra/harness-host-apiproxy/api'
import { CardForm, numberField, type CardFieldState, type CardShell } from './card-form.ts'

/** Settings namespace owning product search selection and limits. */
export const WEB_SEARCH_NS = 'web-search'

/** A provider's configuration values; credentials are never included. */
export type WebSearchSettings = Record<string, unknown>

interface ProviderForm {
  descriptor: WebSearchProviderDescriptor
  scope: SettingsScope<WebSearchSettings>
  form: CardForm<WebSearchSettings>
  credential: { ref: string; configured: boolean; writable: boolean }
  saveRef?: string
  credentialRead: number
}

/** Complete, secret-free configuration metadata and local write-only credential draft. */
export interface WebSearchCardState extends CardShell {
  loading: boolean
  loadFailed: boolean
  providers: WebSearchProviderDescriptor[]
  provider: string
  enabled: boolean
  fields: Record<string, CardFieldState>
  providerFields: Record<string, CardFieldState>
  controls: SearchConfigField[]
  apiKey: CardFieldState
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
  authentication: string
  testing: boolean
  connectionStatus: string
}

/** The section's snapshot and explicit staged actions. */
export interface WebSearchCardFace {
  hooks: { webSearchCard: SnapshotStore<WebSearchCardState> }
  edit: (field: string, text: string) => void
  editProvider: (field: string, text: string) => void
  removeKey: () => void
  save: () => void
  discard: () => void
  testConnection: () => void
  reload: () => void
}

/** Coordinates the existing CardForm across the selected-provider and provider namespaces. */
export class WebSearchCardController {
  private readonly global: CardForm<WebSearchSettings>
  private readonly providers = new Map<string, ProviderForm>()
  private readonly store: SnapshotStore<WebSearchCardState>
  private loading = true
  private loadFailed = false
  private saving = false
  private testing = false
  private connectionStatus = ''
  private generation = 0
  private disposed = false
  private readonly disposers: Array<() => void> = []

  constructor(
    scope: SettingsScope<WebSearchSettings>,
    private readonly api: Pick<IApiClient, 'credentials' | 'webSearch'>,
    private readonly bind: (namespace: string) => SettingsScope<WebSearchSettings>,
  ) {
    this.global = new CardForm(scope, [
      { field: 'provider', format: value => typeof value === 'string' ? value : '', parse: text => ({ kind: 'set', value: text }) },
      { field: 'enabled', format: value => String(value !== false), parse: text => ({ kind: 'set', value: text === 'true' }) },
      numberField('maxQueries'), numberField('maxResults'), numberField('timeoutMs'),
    ])
    this.store = this.global.bind(() => this.projection())
    void this.load()
  }

  private selected(): ProviderForm | undefined { return this.providers.get(this.global.field('provider').text) }

  private projection(): WebSearchCardState {
    const selected = this.selected()
    const shells = [this.global.shell(), ...[...this.providers.values()].map(item => item.form.shell())]
    const fields = Object.fromEntries(['maxQueries', 'maxResults', 'timeoutMs'].map(key => [key, this.global.field(key)]))
    const providerFields: Record<string, CardFieldState> = {}
    for (const field of selected?.descriptor.fields ?? []) providerFields[field.key] = selected?.form.field(field.key) as CardFieldState
    return {
      ...this.global.shell(), dirty: shells.some(shell => shell.dirty), invalid: shells.some(shell => shell.invalid),
      failed: shells.some(shell => shell.failed), saving: this.saving,
      loading: this.loading, loadFailed: this.loadFailed,
      providers: [...this.providers.values()].map(item => item.descriptor),
      provider: this.global.field('provider').text, enabled: this.global.field('enabled').text === 'true',
      fields, providerFields, controls: selected?.descriptor.fields ?? [],
      apiKey: selected?.form.field('apiKey') ?? { text: '', overridden: false, invalid: false },
      apiKeyConfigured: selected?.credential.configured ?? false, apiKeyWritable: selected?.credential.writable ?? false,
      authentication: selected?.descriptor.fields.some(field => field.key === 'auth') ? selected.form.field('auth').text : 'key',
      testing: this.testing, connectionStatus: this.connectionStatus,
    }
  }

  private publish(): void { if (!this.disposed) this.store.set(this.projection()) }

  private async load(): Promise<void> {
    this.loading = true
    this.loadFailed = false
    this.publish()
    try {
      const response = await this.api.webSearch.providers({})
      if (this.disposed) return
      if (!response.result.ok) throw new Error('Provider directory unavailable')
      for (const descriptor of response.result.value.providers) {
        if (this.providers.has(descriptor.id)) continue
        const scope = this.bind(descriptor.settingsNs)
        const form = new CardForm(scope, descriptor.fields.map(field => field.kind === 'number' ? numberField(field.key) : {
          field: field.key, format: value => typeof value === 'string' ? value : '',
          parse: text => ({ kind: 'set', value: text.trim() }),
        }), [{
          field: 'apiKey',
          write: value => this.writeCredential(descriptor.id, value),
          remove: () => this.writeCredential(descriptor.id),
        }])
        const provider: ProviderForm = { descriptor, scope, form, credential: { ref: '', configured: false, writable: false }, credentialRead: 0 }
        this.providers.set(descriptor.id, provider)
        this.disposers.push(form.bind(() => form.shell()).subscribe(() => { this.publish() }))
        this.disposers.push(scope.subscribe(() => { void this.readCredential(provider) }))
        void this.readCredential(provider)
      }
    } catch {
      // The directory can be retried without discarding any provider draft.
      this.loadFailed = true
    } finally { this.loading = false; this.publish() }
  }

  private credentialRef(provider: ProviderForm): string {
    return provider.descriptor.fields.some(field => field.key === 'apiKeyEnv')
      ? provider.form.field('apiKeyEnv').text || provider.descriptor.credentialRef : provider.descriptor.credentialRef
  }

  private async readCredential(provider: ProviderForm): Promise<void> {
    const ref = this.credentialRef(provider)
    const revision = ++provider.credentialRead
    if (provider.credential.ref !== ref) provider.credential = { ref, configured: false, writable: false }
    this.publish()
    try {
      const response = await this.api.credentials.describe({ refs: [ref] })
      if (this.disposed || revision !== provider.credentialRead || ref !== this.credentialRef(provider) || !response.result.ok) return
      const view = response.result.value.credentials[ref]
      provider.credential = { ref, configured: view?.configured ?? false, writable: view?.writable ?? false }
      this.publish()
    } catch {
      // A failed credential status read never claims an unknown key is configured.
      if (revision === provider.credentialRead) { provider.credential = { ref, configured: false, writable: false }; this.publish() }
    }
  }

  private async writeCredential(id: string, value?: string): Promise<boolean> {
    const provider = this.providers.get(id) as ProviderForm
    const ref = provider.saveRef ?? this.credentialRef(provider)
    try {
      const response = value === undefined ? await this.api.credentials.unset({ ref }) : await this.api.credentials.set({ ref, value })
      await this.readCredential(provider)
      return response.result.ok
    } catch { return false } // A missing acknowledgement preserves the write-only draft.
  }

  private changed(): void { this.generation++; this.connectionStatus = ''; this.publish() }

  private async save(): Promise<void> {
    if (this.saving || this.projection().invalid) return
    this.saving = true
    this.changed()
    const globalWrite = this.global.prepareSave()
    const writes = [...this.providers.values()].map((provider) => {
      provider.saveRef = this.credentialRef(provider)
      return { provider, run: provider.form.prepareSave() }
    })
    try {
      for (const { provider, run } of writes) {
        await run()
        if (provider.form.shell().failed) return
      }
      await globalWrite()
    } finally {
      for (const { provider } of writes) delete provider.saveRef
      this.saving = false
      this.publish()
    }
  }

  private async testConnection(): Promise<void> {
    const state = this.projection()
    if (state.dirty || state.saving || state.testing || !state.enabled || !state.provider) return
    const generation = this.generation
    this.testing = true
    this.connectionStatus = ''
    this.publish()
    try {
      const response = await this.api.webSearch.testConnection({ provider: state.provider })
      if (generation !== this.generation) return
      const result = response.result
      this.connectionStatus = !result.ok ? 'Connection test failed.' : result.value.connected
        ? `Connected. Search returned ${result.value.resultCount} results.` : `${result.value.code}: ${result.value.message}`
    } catch {
      if (generation === this.generation) this.connectionStatus = 'Connection test failed.'
    } finally { this.testing = false; this.publish() }
  }

  /**
   * Refresh only the provider credentials affected by an external write.
   * @param ref - changed credential reference.
   */
  refreshCredential(ref: string): void {
    for (const provider of this.providers.values()) if (this.credentialRef(provider) === ref) void this.readCredential(provider)
  }

  /** Release observers and suppress late replies when the client plugin unloads. */
  dispose(): void {
    this.disposed = true
    for (const dispose of this.disposers) dispose()
    this.global.dispose()
    for (const provider of this.providers.values()) provider.form.dispose()
  }

  /**
   * Bind the section to its retained form state.
   * @returns the section snapshot and staged, explicit-save actions.
   */
  inject(): WebSearchCardFace {
    return {
      hooks: { webSearchCard: this.store },
      edit: (field, text) => { this.global.actions().edit(field, text); this.changed() },
      editProvider: (field, text) => {
        const provider = this.selected()
        provider?.form.actions().edit(field, text)
        if (provider !== undefined && field === 'apiKeyEnv') void this.readCredential(provider)
        this.changed()
      },
      removeKey: () => { this.selected()?.form.actions().resetField('apiKey'); this.changed() },
      save: () => { void this.save() },
      discard: () => {
        if (this.saving) return
        this.global.actions().discard()
        for (const provider of this.providers.values()) { provider.form.actions().discard(); void this.readCredential(provider) }
        this.changed()
      },
      testConnection: () => { void this.testConnection() },
      reload: () => { void this.load() },
    }
  }
}
