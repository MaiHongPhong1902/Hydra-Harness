/** Jev credential editor over the Host's resolved provider configuration. */
import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@hydra1902/harness-client-ui-slots'
import type { SettingsDescribeFace } from '@hydra1902/harness-client-ui-settings/client'
import type {} from '@hydra1902/harness-client-ui-settings-models/client'
import styles from './JevProviderOption.module.css'

/** Settings supply configuration; credential writes return acknowledgement only. */
export interface JevProviderInjected {
  hooks: { settings: SettingsDescribeFace }
  saveKey: (ref: string, value: string) => Promise<boolean>
}

type Props = PropsRuntime<'settings.models.provider-option'> & InjectFace<JevProviderInjected>

/**
 * Render the provider option, saved credential row, or write-only key editor.
 * @param props - slot selection and Host settings access.
 * @returns the selected view, or no row without a confirmed credential.
 */
export function JevProviderOption(props: Props): ReactNode {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const settings = props.useSettings(value => value)
  if (props.mode === 'option') {
    return <option value="plugin:jev" data-hydra-provider-option="jev">Jev</option>
  }
  const rawConfig = settings.view?.namespaces.find(row => row.ns === 'jev')?.value
  const config = typeof rawConfig === 'object' && rawConfig !== null ? rawConfig as Record<string, unknown> : undefined
  const ready = settings.error === null && typeof config?.['apiKeyEnv'] === 'string' && typeof config['model'] === 'string'
  if (props.mode === 'row') {
    if (!ready || props.credentials[config['apiKeyEnv'] as string]?.configured !== true) return null
    return (
      <li className={styles['row']}>
        <span>Jev</span>
        <span className={styles['configured']} role="img" aria-label="API key configured" title="API key configured" />
        <button type="button" className={styles['edit']} aria-label="Edit Jev" onClick={() => { props.onEdit('jev') }}>Edit</button>
      </li>
    )
  }
  const disabled = props.readOnly || saving || !ready
  const save = async (): Promise<void> => {
    /* v8 ignore next -- the native disabled button prevents user invocation. */
    if (disabled) return
    const value = key.trim()
    if (value === '') { setError('Enter a Jev API key.'); return }
    setSaving(true)
    setError(undefined)
    try {
      if (!await props.saveKey(config['apiKeyEnv'] as string, value)) {
        setError('Jev credential could not be saved.')
        return
      }
      setKey('')
      props.onClose(true)
    } catch {
      // Wire failures expose no upstream text or credential material.
      setError('Jev credential could not be saved.')
    } finally { setSaving(false) }
  }
  return (
    <div className={styles['editor']}>
      <h4 className={styles['heading']}>Jev</h4>
      <p className={styles['description']}>Decision provider for choices, scores, and yes/no questions. Browser decisions is enabled separately in Plugins.</p>
      {!ready ? <p className={styles['description']} role="status">{settings.status === 'loading' || settings.status === 'idle'
        ? 'Loading Jev settings…' : 'Jev provider settings are unavailable. Check Plugins.'}</p> : null}
      <label className={styles['field']}>
        <span>API key</span>
        <input data-hydra-control="field" type="password" value={key} autoComplete="off" disabled={disabled}
          onChange={(event) => { setKey(event.target.value); setError(undefined) }} />
      </label>
      {ready ? <p className={styles['description']}>Model: {String(config['model'])}</p> : null}
      {error === undefined ? null : <p className={styles['error']} role="alert">{error}</p>}
      <div className={styles['actions']}>
        <button type="button" className={styles['edit']} disabled={disabled} onClick={() => { void save() }}>{saving ? 'Saving…' : 'Apply'}</button>
        <button type="button" className={styles['edit']} disabled={saving} onClick={() => { props.onClose(false) }}>Cancel</button>
      </div>
    </div>
  )
}
