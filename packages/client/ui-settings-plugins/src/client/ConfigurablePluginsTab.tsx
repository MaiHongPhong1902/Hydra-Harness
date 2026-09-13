/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch.
 */

import { Fragment } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@hydra/harness-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the configurable tab. */
export type ConfigurablePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<ConfigurablePluginsTabFace>

/**
 * Render cards registered by plugins that expose editable settings.
 * @param props - locale copy, slot rendering, and the namespaces to dispatch.
 * @returns the card list, or the empty line once the Host has answered.
 */
export function ConfigurablePluginsTab(props: ConfigurablePluginsTabProps) {
  const { t, renderSlot, query } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingNamespaces = namespaces.filter(namespace => namespace.toLocaleLowerCase().includes(normalizedQuery))
  if (matchingNamespaces.length > 0) {
    return (
      <div className={css.cards} role="list">
        {matchingNamespaces.map(ns => (
          // One dispatch per namespace, so the list identity is the namespace
          // rather than a position that shifts as cards arrive.
          <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
        ))}
      </div>
    )
  }
  if (!loaded) return null
  return <p className={css.empty}>{namespaces.length === 0 ? t('empty') : t('emptySearch')}</p>
}
