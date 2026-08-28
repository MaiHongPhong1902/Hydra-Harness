/** Obsidian MCP controls in the dedicated Plugins tab. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { McpSettingsFace } from './mcp-settings-controller.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the MCP tab. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<McpSettingsFace>

/** Render the current MCP setup without exposing its stored credential. */
export function McpSettingsTab(props: McpSettingsTabProps) {
  const { t } = props
  const state = props.useMcpSettings(snapshot => snapshot)
  if (!state.available) return <p className={css.empty}>{t('mcpUnavailable')}</p>
  return (
    <div className={css.cards} role="list">
      <PluginCard
        t={t}
        titleKey="mcpTitle"
        descriptionKey="mcpDescription"
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
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
      </PluginCard>
    </div>
  )
}
