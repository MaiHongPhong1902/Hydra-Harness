import { useEffect, useState, type ReactNode } from 'react'
import type { ImportedPluginSnapshot } from '@hydra/harness-api-remotes/client'
import { Button } from '@hydra/harness-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydra/harness-client-ui-slots'
import { groupByOwner, matchesQuery } from './marketplace-owner.ts'
import css from './PluginInventorySettingsTab.module.css'

/** Imported capability groups with separate settings ownership. */
export type ImportedPluginCapability = 'skills' | 'hooks'

/** Remote controls shared by the Skills and Hooks tabs. */
export interface ImportedPluginCapabilitiesTabInjected {
  list: () => Promise<ImportedPluginSnapshot>
  capability: ImportedPluginCapability
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
  { active, capability, list, query, trust, untrust, t }: ImportedPluginCapabilitiesTabProps,
): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [mutating, setMutating] = useState<string>()

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

  const mutate = (identity: string, action: (value: string) => Promise<ImportedPluginSnapshot>): void => {
    setMutating(identity)
    void action(identity).then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setRequest(value => value + 1) },
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

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || mutating !== undefined}>
      {title === undefined ? null : (
        <div className={css.catalogHeading}><h3>{title}</h3>{state.status === 'ready' ? <span>{total}</span> : null}</div>
      )}
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? <div className={css.failure}><p role="alert">{t('importedPluginLoadError')}</p><button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button></div> : null}
      {state.status === 'ready' && rows.length === 0 ? <p className={css.status}>{capability === 'skills' ? t('importedPluginNoSkills') : t('importedPluginNoHooks')}</p> : null}
      {state.status === 'ready' && rows.length > 0 && total === 0 ? <p className={css.status}>{t('emptySearch')}</p> : null}
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
