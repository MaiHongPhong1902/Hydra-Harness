import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type {
  ImportedPluginSnapshot, PluginEnablementResult, PluginImportSource, PluginInventorySnapshot,
} from '@bosch/bh-api-remotes/client'
import { Button, Input, Switch } from '@bosch/bh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']

/** Local controls for the deployment's configured plugin entries. */
export interface NativePluginControls {
  /** Read the current Host plugin inventory. */
  list: () => Promise<PluginInventorySnapshot>
  /** Persist one configured plugin's enablement. */
  setEnabled: (entryId: PluginInventoryEntry['entryId'], enabled: boolean) => Promise<PluginEnablementResult>
}

/** Local controls for imported OpenAI/Codex bundles. */
export interface ImportedPluginControls {
  /** Read imported OpenAI/Codex bundle state. */
  list: () => Promise<ImportedPluginSnapshot>
  /** Import one direct source or marketplace entry into the BH home. */
  import: (source: PluginImportSource) => Promise<ImportedPluginSnapshot>
  enable: (identity: string) => Promise<ImportedPluginSnapshot>
  disable: (identity: string) => Promise<ImportedPluginSnapshot>
  remove: (identity: string) => Promise<ImportedPluginSnapshot>
}

/** Registration-side Remote face used by the Plugins tab. */
export interface PluginInventorySettingsTabInjected {
  /** Native inventory controls are available only in the local desktop app. */
  nativePlugins?: NativePluginControls
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginInventorySettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<PluginInventorySettingsTabInjected>

type NativeViewState =
  | { readonly status: 'unavailable' }
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

type ImportedViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ImportedPluginSnapshot }

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<PluginFiberPhase, null>, PluginInventoryLocaleKey>

/** Localized label for one root Fiber phase. */
function phaseLabel(phase: PluginFiberPhase, t: PluginInventorySettingsTabProps['t']): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Compact a module specifier without guessing whether its Loader id was generated. */
function moduleShortName(moduleName: string): string {
  const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName
  return unscoped
    .replace(/^cordis:/, '')
    .replace(/^cordis-plugin-/, '')
    .replace(/^bh-(?:host-|client-)?/, '')
}

/** Whether an inventory row matches the local catalog query. */
function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
  return normalizedQuery.length === 0 || [entry.moduleName, entry.entryId]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

/** Render the deployment's plugin inventory and its safe in-app controls. */
function NativePluginCatalog({ nativePlugins, t }: Pick<PluginInventorySettingsTabProps, 'nativePlugins' | 't'>): ReactNode {
  const searchId = useId()
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<NativeViewState>(
    nativePlugins === undefined ? { status: 'unavailable' } : { status: 'loading' },
  )
  const [mutating, setMutating] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [mutationFailed, setMutationFailed] = useState(false)

  useEffect(() => {
    if (nativePlugins === undefined) {
      setState({ status: 'unavailable' })
      return undefined
    }
    let current = true
    setState({ status: 'loading' })
    void Promise.resolve().then(() => nativePlugins.list()).then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [nativePlugins, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const entries = useMemo(
    () => state.status === 'ready'
      ? state.snapshot.entries.filter(entry => matches(entry, normalizedQuery))
      : [],
    [normalizedQuery, state],
  )
  const retry = (): void => { setRequest(value => value + 1) }
  const toggle = (entry: PluginInventoryEntry): void => {
    if (nativePlugins === undefined || !entry.toggleable) return
    setMutating(entry.entryId)
    setMutationFailed(false)
    const enabled = entry.pendingEnabled ?? entry.enabled
    void nativePlugins.setEnabled(entry.entryId, !enabled).then(
      ({ snapshot }) => { setState({ status: 'ready', snapshot }) },
      () => { setMutationFailed(true) },
    ).finally(() => { setMutating(null) })
  }

  if (state.status === 'unavailable') return <p className={css.status}>{t('pluginUnavailable')}</p>

  return (
    <section className={css.catalog} aria-labelledby={`${searchId}-title`} aria-busy={state.status === 'loading' || mutating !== null}>
      <div className={css.catalogHeading}>
        <h3 id={`${searchId}-title`}>{t('catalog')}</h3>
        {state.status === 'ready' ? <span data-plugin-count={entries.length}>{entries.length}</span> : null}
      </div>
      <label className={css.search} htmlFor={searchId}>
        <span className={css.visuallyHidden}>{t('search')}</span>
        <Input id={searchId} type="search" value={query} placeholder={t('search')} onChange={(event) => { setQuery(event.currentTarget.value) }} />
      </label>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {mutationFailed ? <p className={css.mutationFailure} role="alert">{t('toggleError')}</p> : null}
      {state.status === 'ready' && state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {state.status === 'ready' && state.snapshot.entries.length > 0 && entries.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {entries.length > 0 ? (
        <ul className={css.cards}>
          {entries.map((entry) => {
            const status = phaseLabel(entry.fiberPhase, t)
            const title = moduleShortName(entry.moduleName)
            const enabled = entry.pendingEnabled ?? entry.enabled
            return (
              <li className={css.card} key={entry.entryId} data-plugin-entry={entry.entryId}>
                <div className={css.nativePlugin}>
                  <div className={css.importedPluginHeader}>
                    <strong title={entry.moduleName}>{title}</strong>
                    <label className={css.switchControl}>
                      <span>{mutating === entry.entryId ? t('saving') : enabled ? t('enabledTag') : t('disabledTag')}</span>
                      <Switch
                        checked={enabled}
                        disabled={mutating !== null || !entry.toggleable}
                        aria-label={`${t(enabled ? 'disablePlugin' : 'enablePlugin')} ${title}`}
                        onClick={() => { toggle(entry) }}
                      />
                    </label>
                  </div>
                  <code>{entry.moduleName}</code>
                  {entry.enabled ? <span className={css.nativeStatus}>{t('cordis')}: {status}</span> : null}
                  {entry.restartRequired ? <p className={css.status}>{t('restartRequired')}</p> : null}
                  {!entry.toggleable ? <p className={css.status}>{t('requiredPlugin')}</p> : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

/** Render OpenAI/Codex bundle lifecycle controls without duplicating capability settings. */
export function ImportedPluginCatalog({ importedPlugins, t }: { importedPlugins: ImportedPluginControls; t: PluginInventorySettingsTabProps['t'] }): ReactNode {
  const sourceId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ImportedViewState>({ status: 'loading' })
  const [mutating, setMutating] = useState<string>()
  const [mutationFailed, setMutationFailed] = useState(false)

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void importedPlugins.list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [importedPlugins, request])

  const retry = (): void => { setRequest(value => value + 1) }
  const mutate = (identity: string, action: (value: string) => Promise<ImportedPluginSnapshot>): void => {
    setMutating(identity)
    setMutationFailed(false)
    void action(identity).then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setMutationFailed(true) },
    ).finally(() => { setMutating(undefined) })
  }

  return (
    <section className={css.imported} aria-labelledby={`${sourceId}-title`}>
      <div className={css.catalogHeading}>
        <h3 id={`${sourceId}-title`}>{t('importedPlugins')}</h3>
        {state.status === 'ready' ? <span>{state.snapshot.plugins.length}</span> : null}
      </div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('importedPluginLoadError')}</p>
          <button type="button" onClick={retry}>{t('importedPluginRetry')}</button>
        </div>
      ) : null}
      {mutationFailed ? <p className={css.mutationFailure} role="alert">{t('importedPluginMutationError')}</p> : null}
      {state.status === 'ready' && state.snapshot.plugins.length === 0 ? <p className={css.status}>{t('importedPluginEmpty')}</p> : null}
      {state.status === 'ready' && state.snapshot.plugins.length > 0 ? (
        <ul className={`${css.cards} ${css.importedCards}`}>
          {[...state.snapshot.plugins].sort((a, b) => a.name.localeCompare(b.name)).map(plugin => (
            <li className={css.card} key={plugin.identity} data-imported-plugin={plugin.identity}>
              <div className={css.importedPlugin}>
                <div className={css.importedPluginHeader}>
                  <strong>{plugin.name}</strong>
                  <label className={css.switchControl}>
                    <span>{mutating === plugin.identity ? t('saving') : plugin.enabled ? t('enabledTag') : t('disabledTag')}</span>
                    <Switch
                      checked={plugin.enabled}
                      disabled={mutating === plugin.identity}
                      aria-label={`${t(plugin.enabled ? 'importedPluginDisable' : 'importedPluginEnable')} ${plugin.name}`}
                      onClick={() => { mutate(plugin.identity, plugin.enabled ? importedPlugins.disable : importedPlugins.enable) }}
                    />
                  </label>
                </div>
                <code>{plugin.identity} · {plugin.version} · {plugin.source.kind}</code>
                <div className={css.importedPluginActions}>
                  <Button variant="outline" size="sm" disabled={mutating === plugin.identity} onClick={() => { mutate(plugin.identity, importedPlugins.remove) }}>
                    {t('importedPluginRemove')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** Render native BH plugins without mixing in imported OpenAI/Codex bundles. */
export function PluginInventorySettingsTab({ nativePlugins, t }: PluginInventorySettingsTabProps): ReactNode {
  if (nativePlugins === undefined) return <p className={css.status}>{t('pluginUnavailable')}</p>
  return <div className={css.section}><NativePluginCatalog nativePlugins={nativePlugins} t={t} /></div>
}
