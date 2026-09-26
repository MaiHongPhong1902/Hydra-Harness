/** Ordered write-only fallback keys shared by provider creation and editing. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CredentialView, IApiClient } from '@hydra1902/harness-api-remotes/client'
import { apiKeyFailure } from './apiKey.ts'
import { deriveKeyRef, fallbackKeyRefs } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

interface KeyDraft {
  ref: string
  value: string
  existing: boolean
}

/**
 * Keep drafts and acknowledged credential writes across a partial Save failure.
 * @param profile - effective profile at editor opening.
 * @param provider - provider route used for managed reference names.
 * @param api - write-only credential operations.
 * @returns staged keys, validation, and retryable credential persistence.
 */
export function useFallbackKeys(profile: unknown, provider: string, api: Pick<IApiClient, 'credentials'>) {
  const [original] = useState(() => fallbackKeyRefs(profile))
  const [rows, setRows] = useState<KeyDraft[]>(() => original.map(ref => ({ ref, value: '', existing: true })))
  const savedRefs = useRef(new Set<string>())
  const [states, setStates] = useState<Record<string, CredentialView>>({})
  const refs = rows.map(row => row.ref)
  const refsKey = JSON.stringify(refs)
  const describedRefs = [...new Set([...original, ...refs])]
  useEffect(() => {
    let stale = false
    if (describedRefs.length > 0) void api.credentials.describe({ refs: describedRefs }).then((response) => {
      if (!stale && response.result.ok) setStates(response.result.value.credentials)
    }, () => undefined)
    return () => { stale = true }
  }, [api.credentials, refsKey])

  const failure = rows.map(row => apiKeyFailure(row.value) ?? (!row.existing && row.value.length === 0 ? 'keyBlank' : undefined))
    .find(value => value !== undefined)

  const save = async (): Promise<string | undefined> => {
    for (const row of rows) {
      if (row.value.length === 0) continue
      const response = await api.credentials.set({ ref: row.ref, value: row.value.trim() })
      if (!response.result.ok) return response.result.error.message
      savedRefs.current.add(row.ref)
      setRows(current => current.map(item => item.ref === row.ref ? { ...item, value: '', existing: true } : item))
    }
    for (const ref of new Set([...original, ...savedRefs.current])) {
      if (refs.includes(ref) || !isManagedFallbackRef(provider, ref)
        || (states[ref]?.writable !== true && !savedRefs.current.has(ref))) continue
      const response = await api.credentials.unset({ ref })
      if (!response.result.ok) return response.result.error.message
    }
    return undefined
  }
  return {
    rows, states, refs, failure, save,
    saved: savedRefs.current,
    changed: JSON.stringify(original) !== refsKey,
    add: () => { setRows(current => [...current, {
      ref: `${deriveKeyRef(provider)}_FALLBACK_${crypto.randomUUID().replaceAll('-', '_').toUpperCase()}`,
      value: '', existing: false,
    }]) },
    remove: (ref: string) => { setRows(current => current.filter(row => row.ref !== ref)) },
    edit: (ref: string, value: string) => { setRows(current => current.map(row => row.ref === ref ? { ...row, value } : row)) },
  }
}

/**
 * Identify unique key references created by this page.
 * @param provider - owning provider route.
 * @param ref - credential reference to check.
 * @returns whether the reference uses this page's UUID naming rule.
 */
export function isManagedFallbackRef(provider: string, ref: string): boolean {
  const prefix = `${deriveKeyRef(provider)}_FALLBACK_`
  return ref.startsWith(prefix) && /^[A-F0-9]{8}(?:_[A-F0-9]{4}){3}_[A-F0-9]{12}$/.test(ref.slice(prefix.length))
}

/**
 * Render masked fallback fields in request order.
 * @param props - staged keys, write controls, and translated copy.
 * @returns key rows and the Add key action.
 */
export function FallbackKeysEditor(props: {
  keys: ReturnType<typeof useFallbackKeys>
  disabled: boolean
  structureDisabled?: boolean
  t: (key: keyof typeof en) => string
}): ReactNode {
  const { keys, disabled, t } = props
  return <>
    {keys.rows.map((row, index) => {
      const state = keys.states[row.ref]
      const label = `${t('fallbackKey')} ${index + 1}`
      const failure = apiKeyFailure(row.value)
      return <div className={styles['field']} key={row.ref}>
        <span className={styles['fieldLabel']}>{label}</span>
        <div className={styles['keyRow']}>
          <input data-hydra-control="field" className={styles['input']} type="password" autoComplete="off"
            aria-label={label} aria-invalid={failure !== undefined}
            disabled={disabled || state?.writable === false} value={row.value}
            placeholder={state?.writable === false ? t('keyEnvLocked') : state?.configured || keys.saved.has(row.ref) ? t('keyStored') : t('keyPlaceholder')}
            onChange={(event) => { keys.edit(row.ref, event.target.value) }} />
          <button type="button" className={styles['secondaryButton']}
            aria-label={`${t('removeKey')} ${index + 1}`} disabled={disabled || props.structureDisabled}
            onClick={() => { keys.remove(row.ref) }}>{t('remove')}</button>
        </div>
        {failure === undefined ? null : <p className={styles['error']}>{t(failure)}</p>}
      </div>
    })}
    <button type="button" className={styles['secondaryButton']}
      disabled={disabled || props.structureDisabled} onClick={keys.add}>{t('addKey')}</button>
    <p className={styles['advancedHint']}>{t('fallbackKeysHint')}</p>
  </>
}
