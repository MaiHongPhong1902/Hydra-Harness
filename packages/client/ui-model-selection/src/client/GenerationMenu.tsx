/** Composer generation choices over the same durable settings as the Models page. */
import { useEffect, useState, useSyncExternalStore, type Ref } from 'react'
import clsx from 'clsx'
import type { IApiClient, ModelProviderGroup } from '@hydraharness/harness-api-remotes/client'
import type { SettingsDescribeFace } from '@hydraharness/harness-client-ui-settings/client'
import type { PropsLocale } from '@hydraharness/harness-client-ui-slots'
import { IconCheckOutline16, IconChevronRightOutline14 } from '@hydraharness/harness-client-ui-primitives'
import css from './ModelSelect.module.css'

type Role = 'imageModel' | 'videoModel'
type Selection = { provider: string; model: string }

/** Settings reader and generation catalog/write face supplied by the root plugin. */
export interface GenerationMenuFace {
  /** Shared mirror, refreshed by the settings plugin's invalidation subscriptions. */
  settings: SettingsDescribeFace
  /** Complete model catalog and revision-checked settings writes. */
  api: Pick<IApiClient, 'llm' | 'settings'>
}

function selection(value: unknown): Selection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, model } = value as Record<string, unknown>
  return typeof provider === 'string' && typeof model === 'string' ? { provider, model } : undefined
}

/**
 * Render the two root rows or models advertising the selected generation role.
 * @param props - Shared settings, menu navigation, focus registration, and locale.
 * @returns Generation rows with acknowledged writes and visible retry failures.
 */
export function GenerationMenu({ settings, api, pane, onPane, onClose, itemRef, t }: GenerationMenuFace & PropsLocale<'model'> & {
  pane: 'root' | Role
  onPane: (role: Role) => void
  onClose: () => void
  itemRef: () => Ref<HTMLButtonElement>
}) {
  const mirror = useSyncExternalStore(fn => settings.subscribe(fn), () => settings.getSnapshot())
  const namespace = mirror.view?.namespaces.find(view => view.ns === 'llm-pi-ai')
  const catalogRevision = mirror.view?.namespaces.map(view => `${view.ns}:${view.revision}`).join('|')
  const [groups, setGroups] = useState<ModelProviderGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    void api.llm.models({}).then((response) => {
      if (!active) return
      if (!response.result.ok) { setError(response.result.error.message); return }
      setGroups(response.result.value.groups)
      if (response.result.value.failures.length > 0) setError(response.result.value.failures.map(failure => failure.message).join('\n'))
    }, (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api.llm, catalogRevision, attempt])
  if (namespace === undefined) return null
  const values = namespace.value as Record<string, unknown>
  const current = pane === 'root' ? undefined : selection(values[pane])
  const catalog = pane === 'root' ? [] : groups.map(group => ({
    ...group, models: group.models.filter(model => model.endpoints?.includes(pane === 'imageModel' ? 'images/generations' : 'videos')),
  })).filter(group => group.models.length > 0)
  const choose = async (role: Role, value: Selection | undefined): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await api.settings.mutate({ ns: namespace.ns, expectedRevision: namespace.revision,
        ops: [value === undefined ? { op: 'unset', path: [role] } : { op: 'set', path: [role], value }] })
      if (!response.result.ok) { setError(response.result.error.message); return }
      settings.acceptView(response.result.value)
      onClose()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const label = (value: Selection | undefined): string => {
    if (value === undefined) return t('generation.automatic')
    const group = groups.find(group => group.id === value.provider)
    return group?.models.find(model => model.id === value.model)?.name ?? value.model
  }
  return <>
    {pane === 'root' ? (['imageModel', 'videoModel'] as const).map(role => <button key={role} ref={itemRef()}
      type="button" role="menuitem" className={css.cell} onClick={() => { onPane(role) }}>
      <span className={css.cellLabel}>{t(`menu.${role}`)}</span>
      <span className={css.cellValue}>{label(selection(values[role]))}</span>
      <IconChevronRightOutline14 className={css.cellChevron} />
    </button>) : <>
      {loading && <div className={css.status}>{t('status.loading')}</div>}
      <div className={clsx(css.groups, 'scrollable')} aria-busy={loading || busy}>
        <button ref={itemRef()} type="button" role="menuitemradio" aria-checked={current === undefined}
          className={css.option} disabled={busy || !mirror.view?.writable} onClick={() => { void choose(pane, undefined) }}>
          <span className={css.optionCopy}>{t('generation.automatic')}</span>
          <span className={css.check}>{current === undefined && <IconCheckOutline16 />}</span>
        </button>
        {current !== undefined && !loading && !catalog.some(group =>
          group.id === current.provider && group.models.some(model => model.id === current.model))
          && <button type="button" role="menuitemradio" aria-checked disabled className={css.option}>
            <span className={css.optionCopy}>{`${label(current)} — ${t('generation.unavailable')}`}</span>
          </button>}
        {catalog.map(group => <section key={group.id} role="group" aria-label={`${group.name} (${group.id})`} className={css.group}>
          <div className={css.groupTitle}>{`${group.name} (${group.id})`}</div>
          {group.models.map((model) => {
            const selected = current?.provider === group.id && current.model === model.id
            return <button key={model.id} ref={itemRef()} type="button" role="menuitemradio" aria-checked={selected}
              className={css.option} disabled={busy || !mirror.view?.writable}
              onClick={() => { void choose(pane, { provider: group.id, model: model.id }) }}>
              <span className={css.optionCopy}><span className={css.modelName}>{model.name}</span></span>
              <span className={css.check}>{selected && <IconCheckOutline16 />}</span>
            </button>
          })}
        </section>)}
      </div>
    </>}
    {error !== undefined && <div className={css.error} role="alert"><span>{t('error.action', { message: error })}</span>
      <button type="button" className={css.retry} onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</button></div>}
  </>
}
