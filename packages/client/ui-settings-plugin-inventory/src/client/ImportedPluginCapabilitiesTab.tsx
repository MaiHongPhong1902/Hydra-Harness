import { useEffect, useState, type ReactNode } from 'react'
import type { ImportedPluginSnapshot } from '@bosch/bh-api-remotes/client'
import { Button } from '@bosch/bh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
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
export function ImportedPluginCapabilitiesTab({ capability, list, trust, untrust, t }: ImportedPluginCapabilitiesTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [mutating, setMutating] = useState<string>()

  useEffect(() => {
    let current = true
    setState({ status: 'loading' })
    void list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, request])

  const mutate = (identity: string, action: (value: string) => Promise<ImportedPluginSnapshot>): void => {
    setMutating(identity)
    void action(identity).then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setRequest(value => value + 1) },
    ).finally(() => { setMutating(undefined) })
  }

  const title = capability === 'skills' ? t('skillsTab') : t('hooksTab')
  const rows = state.status === 'ready'
    ? state.snapshot.plugins.filter(plugin => capability === 'skills' ? plugin.skills.length > 0 : plugin.hooks.length > 0)
    : []

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || mutating !== undefined}>
      <div className={css.catalogHeading}><h3>{title}</h3>{state.status === 'ready' ? <span>{rows.length}</span> : null}</div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? <div className={css.failure}><p role="alert">{t('importedPluginLoadError')}</p><button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('retry')}</button></div> : null}
      {state.status === 'ready' && rows.length === 0 ? <p className={css.status}>{capability === 'skills' ? t('importedPluginNoSkills') : t('importedPluginNoHooks')}</p> : null}
      {state.status === 'ready' && rows.length > 0 ? (
        <ul className={`${css.cards} ${css.importedCards}`}>
          {rows.map(plugin => (
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
      ) : null}
    </div>
  )
}
