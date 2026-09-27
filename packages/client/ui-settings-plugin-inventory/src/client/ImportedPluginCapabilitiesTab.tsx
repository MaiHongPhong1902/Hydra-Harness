import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ImportedPluginSnapshot, SkillEntry } from '@hydra1902/harness-api-remotes/client'
import { Button } from '@hydra1902/harness-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@hydra1902/harness-client-ui-slots'
import { groupByOwner, matchesQuery } from './marketplace-owner.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Imported capability groups with separate settings ownership. */
export type ImportedPluginCapability = 'skills' | 'hooks'

/** Session-scoped native skill catalog supplied by the client runtime. */
export interface NativeSkillControls {
  /** Read the current session's user-invocable skills, if a session is selected. */
  list: () => Promise<{ readonly sessionId?: string; readonly skills: readonly SkillEntry[] }>
  /** Current-session selection, so a retained Skills tab refreshes after navigation. */
  currentSession?: HostObservable<{ readonly current: string | undefined }>
}

const EMPTY_CURRENT_SESSION_SNAPSHOT = { current: undefined }
const EMPTY_CURRENT_SESSION: HostObservable<{ readonly current: string | undefined }> = {
  getSnapshot: () => EMPTY_CURRENT_SESSION_SNAPSHOT,
  subscribe: () => () => {},
}

/** Remote controls shared by the Skills and Hooks tabs. */
export interface ImportedPluginCapabilitiesTabInjected {
  list: () => Promise<ImportedPluginSnapshot>
  capability: ImportedPluginCapability
  nativeSkills?: NativeSkillControls
  trust?: (identity: string) => Promise<ImportedPluginSnapshot>
  untrust?: (identity: string) => Promise<ImportedPluginSnapshot>
}

/** Props assembled by the settings tab slot. */
export type ImportedPluginCapabilitiesTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginInventory'>
  & InjectFace<ImportedPluginCapabilitiesTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ImportedPluginSnapshot }

/** Render skills or hooks away from their owning plugin bundle card. */
export function ImportedPluginCapabilitiesTab(
  { active, capability, list, nativeSkills, query, trust, untrust, t }: ImportedPluginCapabilitiesTabProps,
): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [nativeState, setNativeState] = useState<
    | { readonly status: 'unavailable' }
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly snapshot: { readonly sessionId?: string; readonly skills: readonly SkillEntry[] } }
  >(nativeSkills === undefined ? { status: 'unavailable' } : { status: 'loading' })
  const [mutating, setMutating] = useState<string>()
  const [mutationFailed, setMutationFailed] = useState(false)
  const currentSession = nativeSkills?.currentSession ?? EMPTY_CURRENT_SESSION
  const currentSessionId = useSyncExternalStore(
    listener => currentSession.subscribe(listener),
    () => currentSession.getSnapshot(),
    () => currentSession.getSnapshot(),
  ).current

  useEffect(() => {
    if (!active) return undefined
    let current = true
    setState({ status: 'loading' })
    void list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, list, request])

  useEffect(() => {
    if (capability !== 'skills' || nativeSkills === undefined) {
      setNativeState({ status: 'unavailable' })
      return undefined
    }
    if (!active) return undefined
    let current = true
    setNativeState({ status: 'loading' })
    void nativeSkills.list().then(
      (snapshot) => { if (current) setNativeState({ status: 'ready', snapshot }) },
      () => { if (current) setNativeState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, capability, currentSessionId, nativeSkills, request])

  const mutate = (identity: string, action: (value: string) => Promise<ImportedPluginSnapshot>): void => {
    setMutating(identity)
    setMutationFailed(false)
    void action(identity).then(
      (snapshot) => { setMutationFailed(false); setState({ status: 'ready', snapshot }) },
      () => { setMutationFailed(true); setRequest(value => value + 1) },
    ).finally(() => { setMutating(undefined) })
  }

  // Only the skills catalog renders as its own tab and carries a heading; the
  // hooks catalog stacks below the user's own records inside the merged Hooks
  // tab, so it renders its rows bare — the tab itself is the label.
  const title = capability === 'skills' ? t('skillsTab') : undefined
  const rows = state.status === 'ready'
    ? state.snapshot.plugins.filter(plugin => capability === 'skills' ? plugin.skills.length > 0 : plugin.hooks.length > 0)
    : []
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matching = rows.filter(plugin => matchesQuery(
    [plugin.name, plugin.identity, ...(capability === 'skills' ? plugin.skills : plugin.hooks)],
    normalizedQuery,
  ))
  const groups = groupByOwner(matching, plugin => plugin.source.marketplace ?? plugin.source.source)
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const importedSkillNames = new Set(state.status === 'ready'
    ? state.snapshot.plugins.flatMap(plugin => plugin.skills)
    : [])
  const nativeMatching = nativeState.status === 'ready'
    ? nativeState.snapshot.skills
      .filter(skill => !importedSkillNames.has(skill.name))
      .filter(skill => matchesQuery([
        skill.name, skill.description, ...(skill.whenToUse === undefined ? [] : [skill.whenToUse]),
      ], normalizedQuery))
    : []
  const nativeTotal = nativeState.status === 'ready'
    ? nativeState.snapshot.skills.filter(skill => !importedSkillNames.has(skill.name)).length
    : 0
  const nativeSkillCount = nativeState.status === 'ready' ? nativeState.snapshot.skills.length : 0

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || mutating !== undefined}>
      {title === undefined ? null : (
        <div className={css.catalogHeading}><h3>{title}</h3>{state.status === 'ready' ? <span>{total}</span> : null}</div>
      )}
      {mutationFailed ? <p className={css.failure} role="alert">{t('importedPluginMutationError')}</p> : null}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? <div className={css.failure}><p role="alert">{t('importedPluginLoadError')}</p><button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button></div> : null}
      {state.status === 'ready' && rows.length === 0 ? <p className={css.status}>{capability === 'skills' ? t('importedPluginNoSkills') : t('importedPluginNoHooks')}</p> : null}
      {state.status === 'ready' && rows.length > 0 && total === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
      {capability === 'skills' ? (
        <section className={css.marketplaceGroup} aria-label={t('nativeSkillsTitle')}>
          <h4 className={css.marketplaceGroupHeading}>{t('nativeSkillsTitle')}</h4>
          {nativeState.status === 'unavailable' ? <p className={css.status}>{t('nativeSkillsUnavailable')}</p> : null}
          {nativeState.status === 'loading' ? <p className={css.status}>{t('nativeSkillsLoading')}</p> : null}
          {nativeState.status === 'error' ? <div className={css.failure}><p role="alert">{t('nativeSkillsLoadError')}</p><button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button></div> : null}
          {nativeState.status === 'ready' && nativeState.snapshot.sessionId === undefined ? <p className={css.status}>{t('nativeSkillsNoSession')}</p> : null}
          {nativeState.status === 'ready' && nativeState.snapshot.sessionId !== undefined && nativeSkillCount === 0 ? <p className={css.status}>{t('nativeSkillsEmpty')}</p> : null}
          {nativeState.status === 'ready' && nativeSkillCount > 0 && nativeTotal > 0 && nativeMatching.length === 0 ? <p className={css.status}>{t('nativeSkillsEmptySearch')}</p> : null}
          {nativeMatching.length > 0 ? (
            <ul className={`${css.cards} ${css.importedCards}`}>
              {nativeMatching.map(skill => (
                <li className={css.card} key={skill.name}>
                  <div className={css.importedPlugin}>
                    <div className={css.importedPluginHeader}><strong>{skill.name}</strong></div>
                    <p>{skill.description}</p>
                    {skill.whenToUse === undefined ? null : <p className={css.status}>{skill.whenToUse}</p>}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {groups.map(group => (
        <section className={css.marketplaceGroup} key={group.owner} aria-label={group.owner}>
          <h4 className={css.marketplaceGroupHeading}>{group.owner}</h4>
          <ul className={`${css.cards} ${css.importedCards}`}>
            {group.items.map(plugin => (
              <li className={css.card} key={plugin.identity}>
                <div className={css.importedPlugin}>
                  <div className={css.importedPluginHeader}>
                    <strong>{plugin.name}</strong>
                    {capability === 'hooks' ? <span className={css.configTag} data-enabled={plugin.hookTrustState === 'trusted'}>{plugin.hookTrustState === 'pending' ? t('importedPluginPendingTrust') : t('importedPluginTrusted')}</span> : null}
                  </div>
                  <code>{plugin.identity}</code>
                  {capability === 'skills' ? <ul>{plugin.skills.map(skill => <li key={skill}>{skill}</li>)}</ul> : (
                    <>
                      <ul>{plugin.hooks.map(hook => <li key={hook}>{hook}</li>)}</ul>
                      {plugin.hookTrustState === 'pending' && trust !== undefined ? <Button variant="outline" size="sm" disabled={mutating === plugin.identity} onClick={() => { mutate(plugin.identity, trust) }}>{t('importedPluginTrust')}</Button> : null}
                      {plugin.hookTrustState === 'trusted' && untrust !== undefined ? <Button variant="outline" size="sm" disabled={mutating === plugin.identity} onClick={() => { mutate(plugin.identity, untrust) }}>{t('importedPluginUntrust')}</Button> : null}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
