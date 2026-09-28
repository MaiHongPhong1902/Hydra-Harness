/** Page Memory configuration card. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { ValueField } from './fields.tsx'
import type { PageMemoryCardFace, PageMemorySettings } from './page-memory-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props for the page-memory card slot. */
export type PageMemoryCardProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'settings.plugins'> & InjectFace<PageMemoryCardFace>

/** Render editable Page Memory namespace and limits. */
export function PageMemoryCard(props: PageMemoryCardProps) {
  const state = props.usePageMemoryCard(snapshot => snapshot)
  const { t } = props
  const field = (name: keyof PageMemorySettings, id: string, label: string, hint: string, numeric = false) => (
    <ValueField
      id={id} label={label} hint={hint} overriddenLabel={t('overridden')} resetLabel={t('reset')}
      invalidLabel={t('invalidNumber')} disabled={!state.writable} numeric={numeric} {...state[name]}
      onEdit={(text) => { props.edit(name, text) }} onReset={() => { props.resetField(name) }}
    />
  )
  return (
    <PluginCard t={t} titleKey="pageMemoryTitle" descriptionKey="pageMemoryDescription" state={state} onSave={props.save} onDiscard={props.discard}>
      {field('role', 'plugin-config-page-memory-role', t('pageMemoryRole'), t('pageMemoryRoleHint'))}
      {field('locale', 'plugin-config-page-memory-locale', t('pageMemoryLocale'), t('pageMemoryLocaleHint'))}
      {field('storageDir', 'plugin-config-page-memory-storage', t('pageMemoryStorageDir'), t('pageMemoryStorageDirHint'))}
      {field('maxWorkflows', 'plugin-config-page-memory-workflows', t('pageMemoryMaxWorkflows'), t('pageMemoryMaxWorkflowsHint'), true)}
      {field('maxPages', 'plugin-config-page-memory-pages', t('pageMemoryMaxPages'), t('pageMemoryMaxPagesHint'), true)}
      {field('maxContextBytes', 'plugin-config-page-memory-context', t('pageMemoryMaxContextBytes'), t('pageMemoryMaxContextBytesHint'), true)}
      {field('maxObservations', 'plugin-config-page-memory-observations', t('pageMemoryMaxObservations'), t('pageMemoryMaxObservationsHint'), true)}
      {field('maxHistory', 'plugin-config-page-memory-history', t('pageMemoryMaxHistory'), t('pageMemoryMaxHistoryHint'), true)}
      {field('verificationTimeoutMs', 'plugin-config-page-memory-timeout', t('pageMemoryVerificationTimeout'), t('pageMemoryVerificationTimeoutHint'), true)}
      {field('maxRecordBytes', 'plugin-config-page-memory-record', t('pageMemoryMaxRecordBytes'), t('pageMemoryMaxRecordBytesHint'), true)}
    </PluginCard>
  )
}
