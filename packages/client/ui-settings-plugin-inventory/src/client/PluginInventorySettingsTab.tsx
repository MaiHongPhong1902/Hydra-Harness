import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type {
  ImportedPluginSnapshot, PluginEnablementResult, PluginImportSource, PluginInventorySnapshot,
} from '@bosch/bh-api-remotes/client'
import { Button, Switch } from '@bosch/bh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import { groupByOwner, matchesQuery } from './marketplace-owner.ts'
import type { PluginInventoryLocaleKey } from './locales.ts'
import css from './PluginInventorySettingsTab.module.css'

type PluginInventoryEntry = PluginInventorySnapshot['entries'][number]
type PluginFiberPhase = PluginInventoryEntry['fiberPhase']
type ImportedPluginEntry = ImportedPluginSnapshot['plugins'][number]

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
  /** Imported OpenAI/Codex bundle controls; also available only in the local desktop app. */
  importedPlugins?: ImportedPluginControls
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

/** Render the deployment's plugin inventory and its safe in-app controls. */
function NativePluginCatalog({
  nativePlugins,
  onRestartRequiredChange,
  query,
  t,
}: Pick<PluginInventorySettingsTabProps, 'nativePlugins' | 't'> & {
  onRestartRequiredChange: (required: boolean) => void
  query: string
}): ReactNode {
  const headingId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<NativeViewState>(
    nativePlugins === undefined ? { status: 'unavailable' } : { status: 'loading' },
  )
  const [mutating, setMutating] = useState<PluginInventoryEntry['entryId'] | null>(null)
  const [mutationFailed, setMutationFailed] = useState(false)

  useEffect(() => {
    if (nativePlugins === undefined) {
      setState({ status: 'unavailable' })
      onRestartRequiredChange(false)
      return undefined
    }
    let current = true
    setState({ status: 'loading' })
    onRestartRequiredChange(false)
    void Promise.resolve().then(() => nativePlugins.list()).then(
      (snapshot) => {
        if (current) {
          setState({ status: 'ready', snapshot })
          onRestartRequiredChange(snapshot.entries.some(entry => entry.restartRequired))
        }
      },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [nativePlugins, onRestartRequiredChange, request])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groups = useMemo(
    () => {
      const grouped = new Map<string, PluginInventoryEntry[]>()
      if (state.status !== 'ready') return []
      const matching = state.snapshot.entries.filter(
        candidate => matchesQuery([candidate.moduleName, candidate.entryId], normalizedQuery),
      )
      for (const entry of matching) {
        const entries = grouped.get(entry.moduleName) ?? []
        entries.push(entry)
        grouped.set(entry.moduleName, entries)
      }
      return [...grouped.values()]
    },
    [normalizedQuery, state],
  )
  const retry = (): void => { setRequest(value => value + 1) }
  const toggle = (entry: PluginInventoryEntry): void => {
    if (nativePlugins === undefined || !entry.toggleable) return
    setMutating(entry.entryId)
    setMutationFailed(false)
    const enabled = entry.pendingEnabled ?? entry.enabled
    void nativePlugins.setEnabled(entry.entryId, !enabled).then(
      ({ snapshot }) => {
        setState({ status: 'ready', snapshot })
        onRestartRequiredChange(snapshot.entries.some(candidate => candidate.restartRequired))
      },
      () => { setMutationFailed(true) },
    ).finally(() => { setMutating(null) })
  }

  if (state.status === 'unavailable') return <p className={css.status}>{t('pluginUnavailable')}</p>

  return (
    <section className={css.catalog} aria-labelledby={`${headingId}-title`} aria-busy={state.status === 'loading' || mutating !== null}>
      <div className={css.catalogHeading}>
        <h3 id={`${headingId}-title`}>{t('catalog')}</h3>
        {state.status === 'ready' ? <span data-plugin-count={groups.length}>{groups.length}</span> : null}
      </div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {mutationFailed ? <p className={css.mutationFailure} role="alert">{t('toggleError')}</p> : null}
      {state.status === 'ready' && state.snapshot.entries.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {state.status === 'ready' && state.snapshot.entries.length > 0 && groups.length === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {groups.length > 0 ? (
        <ul className={css.cards}>
          {groups.map((group) => {
            const first = group[0]
            if (first === undefined) return null
            const title = moduleShortName(first.moduleName)
            const grouped = group.length > 1
            const controls = (entry: PluginInventoryEntry): ReactNode => {
              const enabled = entry.pendingEnabled ?? entry.enabled
              const presetPrefix = entry.presetId === undefined ? '' : `agent-preset:${entry.presetId}:`
              const instance = entry.presetId === undefined
                ? title
                : `${title} (${entry.presetId}: ${entry.entryId.replace(presetPrefix, '')})`
              return (
                <label className={css.switchControl}>
                  <span>{mutating === entry.entryId ? t('saving') : enabled ? t('enabledTag') : t('disabledTag')}</span>
                  <Switch
                    checked={enabled}
                    disabled={mutating !== null || !entry.toggleable}
                    aria-label={`${t(enabled ? 'disablePlugin' : 'enablePlugin')} ${instance}`}
                    onClick={() => { toggle(entry) }}
                  />
                </label>
              )
            }
            const details = (entry: PluginInventoryEntry): ReactNode => (
              <>
                {entry.presetId === undefined ? null : <span className={css.nativeStatus}>{t('preset')}: {entry.presetId}</span>}
                {entry.newSessionsOnly ? <p className={css.status}>{t('newSessionsOnly')}</p> : null}
                {entry.enabled && !entry.newSessionsOnly ? <span className={css.nativeStatus}>{t('cordis')}: {phaseLabel(entry.fiberPhase, t)}</span> : null}
                {entry.restartRequired ? <p className={css.status}>{t('restartRequired')}</p> : null}
                {!entry.toggleable ? <p className={css.status}>{t('requiredPlugin')}</p> : null}
              </>
            )
            return (
              <li
                className={css.card}
                key={first.moduleName}
                data-plugin-entry={grouped ? undefined : first.entryId}
                data-plugin-module={first.moduleName}
                data-restart-required={group.some(entry => entry.restartRequired) ? 'true' : undefined}
              >
                <div className={css.nativePlugin}>
                  <div className={css.importedPluginHeader}>
                    <strong title={first.moduleName}>{title}</strong>
                    {grouped ? null : controls(first)}
                  </div>
                  <code>{first.moduleName}</code>
                  {grouped ? (
                    <ul className={css.nativeInstances}>
                      {group.map(entry => (
                        <li className={css.nativeInstance} key={entry.entryId} data-plugin-entry={entry.entryId}>
                          <div className={css.nativeInstanceHeader}>
                            <code>{entry.entryId.replace(`agent-preset:${entry.presetId ?? ''}:`, '')}</code>
                            {controls(entry)}
                          </div>
                          {details(entry)}
                        </li>
                      ))}
                    </ul>
                  ) : details(first)}
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
export function ImportedPluginCatalog(
  { importedPlugins, query, t }: { importedPlugins: ImportedPluginControls; query: string; t: PluginInventorySettingsTabProps['t'] },
): ReactNode {
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

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const groups = useMemo(
    () => {
      if (state.status !== 'ready') return []
      const matching = state.snapshot.plugins.filter(plugin => matchesQuery([plugin.name, plugin.identity], normalizedQuery))
      return groupByOwner(matching, plugin => plugin.source.marketplace ?? plugin.source.source)
        .map(group => ({ ...group, items: [...group.items].sort((a, b) => a.name.localeCompare(b.name)) }))
    },
    [normalizedQuery, state],
  )
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

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
        {state.status === 'ready' ? <span>{total}</span> : null}
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
      {state.status === 'ready' && state.snapshot.plugins.length > 0 && total === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {groups.map(group => (
        <section className={css.marketplaceGroup} key={group.owner} aria-label={group.owner}>
          <h4 className={css.marketplaceGroupHeading}>{group.owner}</h4>
          <ul className={`${css.cards} ${css.importedCards}`}>
            {group.items.map((plugin: ImportedPluginEntry) => (
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
        </section>
      ))}
    </section>
  )
}

/** Render native BH plugins together with imported OpenAI/Codex bundles: everything the agent can use. */
export function PluginInventorySettingsTab({ nativePlugins, importedPlugins, query, t }: PluginInventorySettingsTabProps): ReactNode {
  const [restartRequired, setRestartRequired] = useState(false)
  if (nativePlugins === undefined) return <p className={css.status}>{t('pluginUnavailable')}</p>
  return (
    <div className={css.section}>
      <NativePluginCatalog nativePlugins={nativePlugins} onRestartRequiredChange={setRestartRequired} query={query} t={t} />
      {importedPlugins === undefined ? null : <ImportedPluginCatalog importedPlugins={importedPlugins} query={query} t={t} />}
      {restartRequired ? <div className={css.restartFooter} role="status">{t('restartFooter')}</div> : null}
    </div>
  )
}
