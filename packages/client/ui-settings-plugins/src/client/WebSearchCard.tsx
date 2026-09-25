/** Search Settings rendered from the backend provider directory. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@hydra/harness-client-ui-slots'
import type {} from '@hydra/harness-client-ui-settings/client'
import type { SearchConfigField } from '@hydra/harness-host-apiproxy/api'
import type { WebSearchCardFace } from './web-search-card-controller.ts'
import type {} from './slot-contract.ts'
import css from './web-search.module.css'

/** Runtime slot, locale, and controller bindings for the standalone section. */
export type WebSearchCardProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.plugins'> & InjectFace<WebSearchCardFace>

/**
 * Render selection, retained provider configuration, and write-only credentials.
 * @param props - backend metadata, staged actions, and localized shared controls.
 * @returns the search settings section.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const state = props.useWebSearchCard(snapshot => snapshot)
  const [replacing, setReplacing] = useState(false)
  const disabled = !state.writable || !state.enabled
  const fieldControl = (field: SearchConfigField, provider: boolean) => {
    const value = (provider ? state.providerFields : state.fields)[field.key]
    const edit = (text: string) => { (provider ? props.editProvider : props.edit)(field.key, text) }
    const id = `search-${provider ? state.provider : 'global'}-${field.key}`
    return (
      <div className={css.field} key={id}>
        <label htmlFor={id}>{field.label}</label>
        {field.kind === 'select' ? (
          <select data-hydra-control="field" id={id} value={value?.text ?? ''} disabled={disabled} onChange={(event) => { edit(event.target.value) }}>
            {field.options?.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : field.kind === 'json' ? (
          <textarea data-hydra-control="field" id={id} value={value?.text ?? ''} disabled={disabled} rows={3} onChange={(event) => { edit(event.target.value) }} />
        ) : (
          <input data-hydra-control="field" id={id} type={field.kind === 'number' ? 'number' : 'text'} min={field.kind === 'number' ? 1 : undefined}
            value={value?.text ?? ''} disabled={disabled} aria-invalid={value?.invalid || undefined}
            onChange={(event) => { edit(event.target.value) }} />
        )}
        {field.hint ? <small>{field.hint}</small> : null}
      </div>
    )
  }
  return (
    <section className={css.section} aria-label="Web Search">
      <h2>Web Search</h2>
      <p>Choose how the agent searches the web. This selection is independent of your chat model.
        The agent chooses search country and language from your prompt.</p>
      {state.loading ? <p role="status">Loading search providers…</p> : null}
      {state.loadFailed ? <p role="alert">Could not load search providers. <button onClick={props.reload}>Retry</button></p> : null}
      <label className={css.toggle}>
        <input type="checkbox" checked={state.enabled} disabled={!state.writable}
          onChange={(event) => { props.edit('enabled', String(event.target.checked)) }} /> Enable Web Search
      </label>
      <div className={css.field}>
        <label htmlFor="search-provider">Search Provider</label>
        <select data-hydra-control="field" id="search-provider" value={state.provider} disabled={disabled}
          onChange={(event) => { setReplacing(false); props.edit('provider', event.target.value) }}>
          <option value="">Select provider…</option>
          {state.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
        </select>
      </div>
      {state.enabled && !state.provider ? <p role="status">Select a search provider before using Web Search.</p> : null}
      {state.provider ? (
        <>
          {state.authentication !== 'none' ? (
            <div className={css.field}>
              <label htmlFor="search-api-key">API Key / Header Value</label>
              <span>{state.apiKey.cleared ? 'Removal pending Save' : state.apiKeyConfigured ? 'Configured' : 'Not configured'}</span>
              <input data-hydra-control="field" id="search-api-key" type="password" autoComplete="off" placeholder={state.apiKeyConfigured ? '••••••••••••••••' : ''}
                value={state.apiKey.text} disabled={!state.enabled || !state.apiKeyWritable || (state.apiKeyConfigured && !replacing)}
                onChange={(event) => { props.editProvider('apiKey', event.target.value) }} />
              <div className={css.actions}>
                <button type="button" disabled={!state.enabled || !state.apiKeyWritable} onClick={() => { setReplacing(true) }}>Replace</button>
                <button type="button" disabled={!state.enabled || !state.apiKeyWritable || !state.apiKeyConfigured}
                  onClick={() => { setReplacing(false); props.removeKey() }}>Remove</button>
              </div>
              <small>Stored through Credentials. Save applies replacement or removal.</small>
            </div>
          ) : null}
          {state.controls.filter(field => !field.advanced).map(field => fieldControl(field, true))}
          <details>
            <summary>Advanced Settings</summary>
            {state.controls.filter(field => field.advanced).map(field => fieldControl(field, true))}
          </details>
        </>
      ) : null}
      <div className={css.limits}>
        {fieldControl({ key: 'maxQueries', label: 'Max Queries per Call', kind: 'number' }, false)}
        {fieldControl({ key: 'maxResults', label: 'Max Total Results', kind: 'number' }, false)}
        {fieldControl({ key: 'timeoutMs', label: 'Search Timeout (ms)', kind: 'number' }, false)}
      </div>
      <div className={css.actions}>
        <button type="button" onClick={props.testConnection} disabled={!state.enabled || !state.provider || state.dirty || state.saving || state.testing}>
          {state.testing ? 'Testing…' : 'Test Connection'}
        </button>
        <span>{state.dirty ? 'Save changes before testing.' : ''}</span>
      </div>
      {state.connectionStatus ? <p role="status">{state.connectionStatus}</p> : null}
      {state.failed ? <p role="alert">{props.t('saveFailed')}</p> : null}
      <footer className={css.actions}>
        <button type="button" onClick={props.discard} disabled={!state.dirty || state.saving}>{props.t('discard')}</button>
        <button type="button" onClick={props.save} disabled={!state.dirty || state.invalid || state.saving}>{props.t(state.saving ? 'saving' : 'save')}</button>
      </footer>
    </section>
  )
}
