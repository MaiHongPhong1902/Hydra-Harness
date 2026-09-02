/** Obsidian and imported-plugin MCP controls in the dedicated Plugins tab. */

import { useEffect, useState } from 'react'
import type { ImportedPluginSnapshot, PluginEnablementResult, PluginInventorySnapshot } from '@bosch/bh-api-remotes/client'
import { Switch } from '@bosch/bh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { McpSettingsFace } from './mcp-settings-controller.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the MCP tab. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<McpSettingsFace & ImportedMcpSettingsFace & NativeMcpSettingsFace>

const OBSIDIAN_MCP_MODULE = '@bosch/bh-obsidian-knowledge'

/** Imported MCP controls that remain separate from the owning bundle lifecycle. */
export interface ImportedMcpSettingsFace {
  importedMcp?: {
    list: () => Promise<ImportedPluginSnapshot>
    setEnabled: (identity: string, server: string, enabled: boolean) => Promise<ImportedPluginSnapshot>
  }
}

/** Local controls for the native Obsidian MCP plugin. */
export interface NativeMcpSettingsFace {
  nativeMcp?: {
    list: () => Promise<PluginInventorySnapshot>
    setEnabled: (
      entryId: PluginInventorySnapshot['entries'][number]['entryId'],
      enabled: boolean,
    ) => Promise<PluginEnablementResult>
  }
}

/** Render the current MCP setup without exposing its stored credential. */
export function McpSettingsTab(props: McpSettingsTabProps) {
  const { t } = props
  const state = props.useMcpSettings(snapshot => snapshot)
  const [request, setRequest] = useState(0)
  const [imported, setImported] = useState<ImportedPluginSnapshot>()
  const [native, setNative] = useState<PluginInventorySnapshot>()
  const [nativeMutating, setNativeMutating] = useState(false)
  const [nativeFailed, setNativeFailed] = useState(false)
  const [importedMutating, setImportedMutating] = useState<string>()
  const [importedFailed, setImportedFailed] = useState(false)

  useEffect(() => {
    if (props.importedMcp === undefined) return undefined
    let current = true
    void props.importedMcp.list().then((snapshot) => {
      if (current) {
        setImported(snapshot)
        setImportedFailed(false)
      }
    }, () => {})
    return () => { current = false }
  }, [props.importedMcp, request])

  useEffect(() => {
    if (props.nativeMcp === undefined) return undefined
    let current = true
    void props.nativeMcp.list().then((snapshot) => { if (current) setNative(snapshot) }, () => {})
    return () => { current = false }
  }, [props.nativeMcp])

  const setImportedEnabled = (identity: string, server: string, enabled: boolean): void => {
    if (props.importedMcp === undefined) return
    setImportedMutating(`${identity}:${server}`)
    setImportedFailed(false)
    void props.importedMcp.setEnabled(identity, server, enabled).then(
      setImported,
      () => { setImportedFailed(true); setRequest(value => value + 1) },
    ).finally(() => { setImportedMutating(undefined) })
  }

  const nativeEntry = native?.entries.find(entry => entry.moduleName === OBSIDIAN_MCP_MODULE)
  const setNativeEnabled = (enabled: boolean): void => {
    if (props.nativeMcp === undefined || nativeEntry === undefined) return
    setNativeMutating(true)
    setNativeFailed(false)
    void props.nativeMcp.setEnabled(nativeEntry.entryId, enabled).then(
      ({ snapshot }) => { setNative(snapshot) },
      () => { setNativeFailed(true) },
    ).finally(() => { setNativeMutating(false) })
  }
  const nativeControl = nativeEntry === undefined ? null : (
    <label className={css.switchControl}>
      <span>{nativeEntry.enabled ? t('mcpEnabled') : t('disabled')}</span>
      <Switch
        checked={nativeEntry.enabled}
        disabled={nativeMutating || !nativeEntry.toggleable}
        aria-label={`${nativeEntry.enabled ? t('disable') : t('enable')} ${t('mcpTitle')}`}
        onClick={() => { setNativeEnabled(!nativeEntry.enabled) }}
      />
    </label>
  )

  if (!state.available && props.importedMcp === undefined && props.nativeMcp === undefined) return <p className={css.empty}>{t('mcpUnavailable')}</p>
  return (
    <div className={css.cards} role="list">
      {state.available ? <PluginCard
        t={t}
        titleKey="mcpTitle"
        descriptionKey="mcpDescription"
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
        action={nativeControl}
      >
        <SecretField
          id="plugin-mcp-obsidian-key"
          label={t('mcpApiKey')}
          hint={t('mcpApiKeyHint')}
          disabled={!state.apiKeyWritable}
          text={state.apiKey.text}
          configured={state.apiKeyConfigured}
          stateLabel={state.apiKeyConfigured ? t('mcpApiKeySet') : t('mcpApiKeyUnset')}
          onEdit={(text) => { props.edit('apiKey', text) }}
        />
        <ValueField
          id="plugin-mcp-target-domain"
          label={t('mcpTargetDomain')}
          hint={t('mcpTargetDomainHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('mcpInvalidDomain')}
          disabled={!state.writable}
          {...state.targetDomain}
          onEdit={(text) => { props.edit('targetDomain', text) }}
          onReset={() => { props.resetField('targetDomain') }}
        />
        {nativeFailed ? <p className={css.empty} role="alert">{t('mcpToggleFailed')}</p> : null}
      </PluginCard> : null}
      {!state.available && native === undefined && props.nativeMcp !== undefined ? <p className={css.empty}>{t('mcpLoading')}</p> : null}
      {!state.available && nativeControl !== null ? (
        <section className={css.importedMcp} aria-labelledby="native-mcp-title">
          <h3 id="native-mcp-title">{t('mcpTitle')}</h3>
          <p className={css.empty}>{t('mcpUnavailable')}</p>
          <div className={css.importedMcpRow}>
            <div><strong>{t('mcpTitle')}</strong><code>{nativeEntry?.moduleName}</code></div>
            {nativeControl}
          </div>
          {nativeFailed ? <p className={css.empty} role="alert">{t('mcpToggleFailed')}</p> : null}
        </section>
      ) : null}
      {props.importedMcp !== undefined ? (
        <section className={css.importedMcp} aria-labelledby="imported-mcp-title">
          <h3 id="imported-mcp-title">{t('importedMcpTitle')}</h3>
          {imported === undefined ? <p className={css.empty}>{t('mcpLoading')}</p> : null}
          {imported !== undefined && imported.plugins.every(plugin => plugin.mcpServers.length === 0) ? <p className={css.empty}>{t('importedMcpEmpty')}</p> : null}
          {importedFailed ? <p className={css.empty} role="alert">{t('mcpToggleFailed')}</p> : null}
          {imported?.plugins.flatMap(plugin => plugin.mcpServers.map(server => ({ plugin, server }))).map(({ plugin, server }) => (
            <div className={css.importedMcpRow} key={`${plugin.identity}:${server.name}`}>
              <div><strong>{server.name}</strong><code>{plugin.name} · {plugin.identity}</code></div>
              <label className={css.switchControl}>
                <span>{importedMutating === `${plugin.identity}:${server.name}` ? t('saving') : server.enabled ? server.startupState : t('disabled')}</span>
                <Switch
                  checked={server.enabled}
                  disabled={importedMutating !== undefined}
                  aria-label={`${server.enabled ? t('disable') : t('enable')} ${server.name}`}
                  onClick={() => { setImportedEnabled(plugin.identity, server.name, !server.enabled) }}
                />
              </label>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}
