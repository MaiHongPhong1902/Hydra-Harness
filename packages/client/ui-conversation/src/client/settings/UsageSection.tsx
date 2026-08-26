/** Settings page for durable provider-reported token usage by model. */
import type { SessionListState } from '@bosch/bh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@bosch/bh-client-ui-slots'
import type {} from '@bosch/bh-token-meter/client'
import css from './UsageSection.module.css'

export interface UsageRow {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}

/** Sum each session's durable model buckets without assigning usage to its latest model. */
export function collectModelUsage(list: Pick<SessionListState, 'ids' | 'byId'>): UsageRow[] {
  const totals = new Map<string, UsageRow>()
  for (const id of list.ids) {
    for (const usage of list.byId[id]?.projectionValues?.modelTokenUsage ?? []) {
      const key = JSON.stringify([usage.provider, usage.model])
      const previous = totals.get(key)
      totals.set(key, {
        provider: usage.provider,
        model: usage.model,
        inputTokens: (previous?.inputTokens ?? 0)
          + usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      })
    }
  }
  return [...totals.values()]
    .filter(row => row.inputTokens + row.outputTokens > 0)
    .sort((a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens
      || a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider))
}

export type UsageSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'conversation'>

/** Render exact token counts grouped across every listed session. */
export function UsageSection({ useSessions, t }: UsageSectionProps) {
  const list = useSessions(state => state)
  const rows = collectModelUsage(list)
  return (
    <section className={css.section} aria-labelledby="settings-usage-title">
      <h2 id="settings-usage-title" className={css.title}>{t('settings.usage.title')}</h2>
      <p className={css.description}>{t('settings.usage.description')}</p>
      {list.phase === 'pending'
        ? <p className={css.empty}>{t('settings.usage.loading')}</p>
        : rows.length === 0
          ? <p className={css.empty}>{t('settings.usage.empty')}</p>
          : (
            <div className={css.tableFrame}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.usage.model')}</th>
                    <th scope="col">{t('settings.usage.input')}</th>
                    <th scope="col">{t('settings.usage.output')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={JSON.stringify([row.provider, row.model])}>
                      <td>
                        <span className={css.model}>{row.model}</span>
                        <span className={css.provider}>{row.provider}</span>
                      </td>
                      <td className={css.number}>{row.inputTokens.toLocaleString()}</td>
                      <td className={css.number}>{row.outputTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </section>
  )
}
