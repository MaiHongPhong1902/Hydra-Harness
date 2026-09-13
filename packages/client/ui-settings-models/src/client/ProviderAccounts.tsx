/** Account login and per-account sign-out through the Host authorization flows. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthorizationAttemptView, AuthorizationEntryView, IApiClient } from '@hydra/harness-api-remotes/client'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

type AuthorizationApi = IApiClient['authorization']

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
  const lifetime = useRef<object | undefined>(undefined)
  const activeAttempt = useRef<string | undefined>(undefined)
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
  const unavailable = entry === undefined || !entry.methods.some(method => method.id === 'oauth')
  return (
    <div className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('accounts')}</span>
      <p className={styles['advancedHint']}>{t('accountsHint')}</p>
      <ul className={styles['accountList']} aria-label={t('accounts')}>
        {entry?.accounts.map(account => (
          <li key={account.id} className={styles['accountRow']}>
            <span>{account.label}</span>
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
          </li>
        ))}
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
        {safeUrl === undefined ? null : <a href={safeUrl} target="_blank" rel="noopener noreferrer">{t('accountOpenBrowser')}</a>}
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
          ? <select id={`auth-${prompt.id}`} className={`${styles['input']} ${styles['selectInput']}`} value={answer} disabled={busy}
            onChange={(event) => { setAnswer(event.target.value) }}>
            <option value="">{t('accountChoose')}</option>
            {prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          : <input id={`auth-${prompt.id}`} className={styles['input']} type={prompt.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off" value={answer} placeholder={prompt.placeholder} disabled={busy}
            onChange={(event) => { setAnswer(event.target.value) }} />}
        <button type="submit" className={styles['secondaryButton']} disabled={busy || answer.trim().length === 0}>{t('accountContinue')}</button>
      </form>}
      {failure === undefined && attempt?.error === undefined ? null
        : <p className={styles['error']} role="alert">{failure ?? attempt?.error}</p>}
    </div>
  )
}
