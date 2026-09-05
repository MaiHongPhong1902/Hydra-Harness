/** The user's own hook records as one Plugins-section tab. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import { HookRecordCatalog, type UserHookControls } from './HookRecordCatalog.tsx'
import css from './PluginsSettingsSection.module.css'

/** The user's own hook records; available only in the local desktop app. */
export interface UserHooksSettingsFace {
  userHooks?: UserHookControls
}

/** Props the renderer binds for the hooks tab. */
export type UserHooksSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<UserHooksSettingsFace>

/**
 * Render the user's hook records, or say the surface is local-only.
 * @param props - the slot-assembled runtime, locale, and injected controls.
 * @returns the hook catalog, or the unavailable notice.
 */
export function UserHooksSettingsTab({ userHooks, query, t }: UserHooksSettingsTabProps) {
  if (userHooks === undefined) return <p className={css.empty}>{t('userHooksUnavailable')}</p>
  return <HookRecordCatalog controls={userHooks} query={query} t={t} />
}
