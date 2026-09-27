/** Account login and per-account sign-out through the Host authorization flows. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AuthorizationAttemptView, AuthorizationEntryView, AuthorizationUsageView, IApiClient,
} from '@hydra/harness-api-remotes/client'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type AuthorizationApi = IApiClient['authorization']

type UsageProvider = 'codex' | 'google' | 'other'

function usageProvider(flowKey: string): UsageProvider {
  if (flowKey.endsWith('/chatgpt')) return 'codex'
  if (flowKey.endsWith('/antigravity')) return 'google'
  return 'other'
}

function remainingPercent(usedPercent: number): number {
  return Math.round(Math.max(0, Math.min(100, 100 - usedPercent)))
}

function resetLabel(resetsAt: number | undefined, t: ProviderAccountsProps['t']): string | undefined {
  return resetsAt === undefined ? undefined
    : t('accountUsageResetAt').replace('{time}', new Date(resetsAt * 1000).toLocaleString())
}

function windowTitle(
  limit: AuthorizationUsageView['limits'][number], provider: UsageProvider,
  t: ProviderAccountsProps['t'],
): string {
  const window = limit.window?.toLocaleLowerCase().replace(/[ _-]+/gu, '')
  const duration = limit.windowMinutes === 300 || /^(?:5h|fivehours?)$/u.test(window ?? '')
    ? t('accountUsage5HourLimit')
    : limit.windowMinutes === 10_080 || /^(?:weekly|week|7d|sevendays?)$/u.test(window ?? '')
      ? t('accountUsageWeeklyLimit') : undefined
  if (duration === undefined) return limit.name
  const genericCodexName = /^(codex|5h|weekly)$/iu.test(limit.name)
  if (provider === 'codex') return genericCodexName ? duration : `${limit.name} · ${duration}`
  return limit.group !== undefined || genericCodexName ? duration : `${limit.name} · ${duration}`
}

function googleGroup(limit: AuthorizationUsageView['limits'][number], t: ProviderAccountsProps['t']): string {
  const value = `${limit.group ?? ''} ${limit.name}`.toLocaleLowerCase()
  if (value.includes('gemini')) return t('accountUsageGeminiModels')
  if (value.includes('claude') || value.includes('gpt')) return t('accountUsageClaudeGptModels')
  return t('accountUsageOtherModels')
}

function UsageLimit({
  limit, provider, t,
}: {
  limit: AuthorizationUsageView['limits'][number]
  provider: UsageProvider
  t: ProviderAccountsProps['t']
}): ReactNode {
  const remaining = remainingPercent(limit.usedPercent)
  const title = windowTitle(limit, provider, t)
  const reset = resetLabel(limit.resetsAt, t)
  const remainingAmount = limit.remainingAmount === undefined ? undefined
    : t('accountUsageRemainingAmount').replace('{amount}', limit.remainingAmount.toLocaleString())
  return (
    <div className={`${styles['usageLimit']}${limit.disabled === true ? ` ${styles['usageLimitDisabled']}` : ''}`}
      title={limit.description}>
      <div className={styles['usageLimitHeader']}>
        <div className={styles['usageLimitIdentity']}>
          <span className={styles['usageLimitTitle']}>{title}</span>
          {reset === undefined ? null : <small>{reset}</small>}
          {remainingAmount === undefined ? null : <small>{remainingAmount}</small>}
        </div>
        <strong>{limit.disabled === true ? t('accountUsageDisabled')
          : t('accountUsageRemaining').replace('{percent}', String(remaining))}</strong>
      </div>
      {limit.disabled === true ? null : <div className={styles['usageBar']} role="progressbar" aria-label={title}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
        <span style={{ width: `${remaining}%` }} />
      </div>}
    </div>
  )
}

function UsageCredits({ value, t }: {
  value: AuthorizationUsageView['credits']
  t: ProviderAccountsProps['t']
}): ReactNode {
  if (value === undefined || value.length === 0) return null
  return (
    <section className={styles['usageGroup']} aria-label={t('accountUsageCreditsTitle')}>
      <h4>{t('accountUsageCreditsTitle')}</h4>
      {value.map((credit) => {
        const name = credit.creditType ?? credit.tier
        const amount = credit.creditAmount === undefined ? t('accountUsageUnavailable')
          : t('accountUsageCreditsAvailable').replace('{name}', name)
            .replace('{amount}', credit.creditAmount.toLocaleString())
        return <div key={credit.tier} className={styles['usageCredit']}>
          <span>{amount}</span>
          {credit.minimumCreditAmountForUsage === undefined ? null
            : <small>{t('accountUsageCreditsMinimum').replace('{amount}', credit.minimumCreditAmountForUsage.toLocaleString())}</small>}
        </div>
      })}
    </section>
  )
}

function UsageReport({
  value, provider, t,
}: {
  value: AuthorizationUsageView
  provider: UsageProvider
  t: ProviderAccountsProps['t']
}): ReactNode {
  const groups = provider === 'google'
    ? [...new Map(value.limits.map(limit => [googleGroup(limit, t), [] as AuthorizationUsageView['limits']])).entries()]
      .map(([title]) => ({ title, limits: value.limits.filter(limit => googleGroup(limit, t) === title) }))
    : [{ title: t('accountUsageQuota'), limits: value.limits }]
  return (
    <div className={styles['usageReport']} aria-label={t('accountUsageTitle')}>
      {provider === 'codex'
        ? <div className={styles['usageSummary']}>
          <span className={styles['usageBank']}>{value.bankedResetCount === undefined
            ? t('accountBankedResetsUnavailable')
            : t('accountBankedResets').replace('{count}', String(value.bankedResetCount))}</span>
        </div>
        : null}
      {provider === 'google' ? <UsageCredits value={value.credits} t={t} /> : null}
      {groups.map(group => (
        <section key={group.title} className={styles['usageGroup']} aria-label={group.title}>
          {provider === 'google' ? <h4>{group.title}</h4> : null}
          {group.limits.map((limit, index) => <UsageLimit key={`${limit.name}-${limit.windowMinutes ?? 'model'}-${index}`}
            limit={limit} provider={provider} t={t} />)}
        </section>
      ))}
      {value.limits.length === 0 ? <p className={styles['usageEmpty']}>{t('accountUsageNoLimits')}</p> : null}
    </div>
  )
}

/** Props for the provider's independently persisted account pool. */
interface ProviderAccountsProps {
  /** Provider-owned authorization flow key. */
  flowKey: string
  /** Authorization wire methods; tokens never reach this component. */
  api: AuthorizationApi
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Prevent account changes in a read-only editor. */
  disabled: boolean
  /** Disable the enclosing Apply action while a login is running. */
  onBusy: (busy: boolean) => void
}

/**
 * Render all accounts, the active login instructions, and account actions.
 * Closing the editor cancels the attempt it owns, including a late begin response.
 * @param props - flow identity, wire methods, and editor state.
 * @returns the account controls and status.
 */
export function ProviderAccounts({ flowKey, api, t, disabled, onBusy }: ProviderAccountsProps): ReactNode {
  const [entry, setEntry] = useState<AuthorizationEntryView>()
  const [attempt, setAttempt] = useState<AuthorizationAttemptView>()
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [usage, setUsage] = useState<Record<string, AuthorizationUsageView | undefined>>({})
  const [usageFailure, setUsageFailure] = useState<Record<string, boolean>>({})
  const lifetime = useRef<object | undefined>(undefined)
  const activeAttempt = useRef<string | undefined>(undefined)
  const usageSequence = useRef(new Map<string, number>())
  const usageControllers = useRef(new Map<string, AbortController>())
  useEffect(() => { setAnswer('') }, [attempt?.prompt?.id])

  useEffect(() => {
    const token = {}
    lifetime.current = token
    void api.list({}).then((response) => {
      if (lifetime.current !== token) return
      if (!response.result.ok) { setFailure(response.result.error.message); return }
      const next = response.result.value.entries.find(candidate => candidate.key === flowKey)
      setEntry(next)
      if (next === undefined) setFailure(t('accountsUnavailable'))
    }, (error: unknown) => {
      if (lifetime.current === token) setFailure(messageOf(error))
    })
    return () => {
      lifetime.current = undefined
      const attemptId = activeAttempt.current
      activeAttempt.current = undefined
      if (attemptId !== undefined) void api.cancel({ attemptId }).catch(() => undefined)
      onBusy(false)
    }
  }, [api, flowKey, onBusy, t])

  const requestUsage = useCallback((accountId: string): void => {
    const token = lifetime.current
    /* v8 ignore if -- account effects and refresh buttons request usage only while mounted. */
    if (token === undefined) return
    const sequence = (usageSequence.current.get(accountId) ?? 0) + 1
    usageSequence.current.set(accountId, sequence)
    usageControllers.current.get(accountId)?.abort()
    const controller = new AbortController()
    usageControllers.current.set(accountId, controller)
    setUsage(current => ({ ...current, [accountId]: undefined }))
    setUsageFailure(current => ({ ...current, [accountId]: false }))
    void api.usage({ key: flowKey, accountId }, controller.signal).then((response) => {
      if (lifetime.current !== token || usageSequence.current.get(accountId) !== sequence) return
      const value = response.result
      if (!value.ok) throw new Error(value.error.message)
      if (value.value.usage === undefined) {
        setUsageFailure(current => ({ ...current, [accountId]: true }))
      } else {
        setUsage(current => ({ ...current, [accountId]: value.value.usage }))
      }
    }).catch(() => {
      if (lifetime.current === token && usageSequence.current.get(accountId) === sequence) {
        setUsageFailure(current => ({ ...current, [accountId]: true }))
      }
    }).finally(() => {
      if (usageControllers.current.get(accountId) === controller) usageControllers.current.delete(accountId)
    })
  }, [api, flowKey])

  useEffect(() => {
    const accounts = entry?.accounts ?? []
    setUsage(() => Object.fromEntries(accounts.map(account => [account.id, undefined])))
    setUsageFailure({})
    for (const account of accounts) requestUsage(account.id)
    return () => {
      for (const account of accounts) {
        usageControllers.current.get(account.id)?.abort()
        usageControllers.current.delete(account.id)
        /* v8 ignore next -- every mounted account schedules usage before cleanup. */
        usageSequence.current.set(account.id, (usageSequence.current.get(account.id) ?? 0) + 1)
      }
    }
  }, [entry?.accounts, requestUsage])

  const attemptId = attempt?.status === 'running' ? attempt.id : undefined
  useEffect(() => {
    if (attemptId === undefined) return
    let stale = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await api.state({ attemptId })
        if (stale) return
        if (!response.result.ok) throw new Error(response.result.error.message)
        const next = response.result.value.attempt
        if (next.status === 'running') {
          setAttempt(next)
          timer = setTimeout(() => { void poll() }, 500)
          return
        }
        const listed = await api.list({})
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can run while account listing awaits.
        if (stale) return
        if (!listed.result.ok) throw new Error(listed.result.error.message)
        setEntry(listed.result.value.entries.find(candidate => candidate.key === flowKey))
        activeAttempt.current = undefined
        onBusy(false)
        setAnswer('')
        setAttempt(next)
      } catch (error) {
        if (stale) return
        setFailure(messageOf(error))
        onBusy(false)
        void api.cancel({ attemptId }).catch(() => undefined)
        activeAttempt.current = undefined
        setAttempt(undefined)
      }
    }
    void poll()
    return () => { stale = true; clearTimeout(timer) }
  }, [api, attemptId, flowKey, onBusy])

  const begin = async (): Promise<void> => {
    const token = lifetime.current
    setBusy(true)
    setFailure(undefined)
    setAttempt(undefined)
    onBusy(true)
    try {
      const response = await api.begin({ key: flowKey, method: 'oauth' })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const attemptId = response.result.value.attemptId
      if (lifetime.current !== token) {
        void api.cancel({ attemptId }).catch(() => undefined)
        return
      }
      activeAttempt.current = attemptId
      setAttempt({ id: attemptId, status: 'running' })
    } catch (error) {
      if (lifetime.current !== token) return
      setFailure(messageOf(error))
      onBusy(false)
    } finally {
      if (lifetime.current === token) setBusy(false)
    }
  }

  const act = async (operation: () => Promise<unknown>): Promise<void> => {
    const token = lifetime.current
    setBusy(true)
    setFailure(undefined)
    try { await operation() } catch (error) {
      if (lifetime.current === token) setFailure(messageOf(error))
    } finally {
      if (lifetime.current === token) setBusy(false)
    }
  }

  const running = attempt?.status === 'running'
  const prompt = running ? attempt.prompt : undefined
  const notice = attempt?.notice
  const safeUrl = notice?.url !== undefined && /^https?:\/\//i.test(notice.url) ? notice.url : undefined
  const openExternal = (globalThis as typeof globalThis & {
    hydraDesktop?: { openExternal?: (url: string) => Promise<void> }
  }).hydraDesktop?.openExternal
  const unavailable = entry === undefined || !entry.methods.some(method => method.id === 'oauth')
  const provider = usageProvider(flowKey)
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('accounts')}</span>
      <p className={styles['advancedHint']}>{t('accountsHint')}</p>
      <ul className={styles['accountList']} aria-label={t('accounts')}>
        {entry?.accounts.map((account) => {
          const accountUsage = usage[account.id]
          return (
            <li key={account.id} className={styles['accountRow']}>
              <div className={styles['accountHeader']}>
                <div className={styles['accountIdentity']}>
                  <span>{account.label}</span>
                  {accountUsage?.planType === undefined ? null
                    : <span className={styles['accountPlan']}>{accountUsage.planType}</span>}
                </div>
                <div className={styles['accountControls']}>
                  <button type="button" className={styles['secondaryButton']} disabled={disabled || busy || running}
                    aria-label={t('accountUsageRefresh').replace('{account}', account.label)}
                    onClick={() => { requestUsage(account.id) }}>↻</button>
                  <button type="button" className={styles['secondaryButton']} disabled={disabled || busy || running}
                    aria-label={t('accountSignOutLabel').replace('{account}', account.label)}
                    onClick={() => { void act(async () => {
                      const response = await api.logout({ key: flowKey, accountId: account.id })
                      if (!response.result.ok) throw new Error(response.result.error.message)
                      const listed = await api.list({})
                      if (!listed.result.ok) throw new Error(listed.result.error.message)
                      if (lifetime.current !== undefined) setEntry(listed.result.value.entries.find(candidate => candidate.key === flowKey))
                    }) }}>
                    {t('accountSignOut')}
                  </button>
                </div>
              </div>
              {accountUsage === undefined
                ? <small className={styles['usageStatus']}>{usageFailure[account.id] ? t('accountUsageUnavailable') : t('accountUsageLoading')}</small>
                : <UsageReport value={accountUsage} provider={provider} t={t} />}
            </li>
          )
        })}
      </ul>
      {entry?.accounts.length === 0 ? <p className={styles['advancedHint']}>{t('accountsEmpty')}</p> : null}
      <div className={styles['accountActions']}>
        <button type="button" className={styles['secondaryButton']} disabled={disabled || busy || running || unavailable}
          onClick={() => { void begin() }}>{t('accountAdd')}</button>
        {running ? <button type="button" className={styles['secondaryButton']} disabled={busy}
          onClick={() => { void act(async () => {
            const response = await api.cancel({ attemptId: attempt.id })
            if (!response.result.ok) throw new Error(response.result.error.message)
          }) }}>{t('accountCancel')}</button> : null}
      </div>
      <div role="status" aria-live="polite">
        {notice === undefined ? null : <p>{notice.message}</p>}
        {safeUrl === undefined ? null : <a href={safeUrl} target="_blank" rel="noopener noreferrer"
          onClick={openExternal === undefined ? undefined : (event) => {
            event.preventDefault()
            void openExternal(safeUrl).catch((error: unknown) => { setFailure(messageOf(error)) })
          }}>{t('accountOpenBrowser')}</a>}
        {notice?.code === undefined ? null : <p><code>{notice.code}</code></p>}
        {attempt?.status === 'authorized' ? <p>{t('accountAdded')}</p> : null}
        {attempt?.status === 'cancelled' ? <p>{t('accountCancelled')}</p> : null}
      </div>
      {prompt === undefined || attempt === undefined ? null : <form key={prompt.id} className={styles['field']} onSubmit={(event) => {
        event.preventDefault()
        void act(async () => {
          const response = await api.answer({ attemptId: attempt.id, promptId: prompt.id, value: answer })
          if (!response.result.ok) throw new Error(response.result.error.message)
          setAnswer('')
        })
      }}>
        <label className={styles['fieldLabel']} htmlFor={`auth-${prompt.id}`}>{prompt.message}</label>
        {prompt.kind === 'select'
          ? <select data-hydra-control="field" id={`auth-${prompt.id}`} className={styles['input']} value={answer} disabled={busy}
            onChange={(event) => { setAnswer(event.target.value) }}>
            <option value="">{t('accountChoose')}</option>
            {prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <input data-hydra-control="field" id={`auth-${prompt.id}`} className={styles['input']} type={prompt.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off" value={answer} placeholder={prompt.placeholder} disabled={busy}
            onChange={(event) => { setAnswer(event.target.value) }} />}
        <button type="submit" className={styles['secondaryButton']} disabled={busy || answer.trim().length === 0}>{t('accountContinue')}</button>
      </form>}
      {failure === undefined && attempt?.error === undefined ? null
        : <p className={styles['error']} role="alert">{failure ?? attempt?.error}</p>}
    </div>
  )
}
