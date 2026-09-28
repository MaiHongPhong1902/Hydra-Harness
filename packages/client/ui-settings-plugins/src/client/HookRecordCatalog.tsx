/**
 * The user's own hook records: the records stored in the harness settings
 * document, with the add, edit, toggle, and remove controls that write them.
 *
 * A record is created disabled and stays that way until the switch is used,
 * because enabling one lets its commands run on every tool call and turn
 * boundary. The form takes definitions as JSON in the record's own dialect, so
 * an existing `hooks.json` can be pasted verbatim; a path record points at such
 * a document instead of copying it.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type {
  HookDialect, HookRecordDefinitionRequest, HookRecordSnapshot, JsonValue,
} from '@hydraharness/harness-api-remotes/client'
import { Button, IconPlusOutline16, Input, Modal, Switch } from '@hydraharness/harness-client-ui-primitives'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import css from './PluginsSettingsSection.module.css'

/** Remote controls for the user's own hook records. */
export interface UserHookControls {
  /** Read every stored record with its live state. */
  list: () => Promise<HookRecordSnapshot>
  /** Store one complete definition and converge its bridge mount. */
  define: (request: HookRecordDefinitionRequest) => Promise<HookRecordSnapshot>
  /** Change one record's desired state. */
  setEnabled: (name: string, enabled: boolean) => Promise<HookRecordSnapshot>
  /** Delete one record and unmount its bridge. */
  remove: (name: string) => Promise<HookRecordSnapshot>
}

type HookRecord = HookRecordSnapshot['records'][number]

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: HookRecordSnapshot }

/** The add/edit form's staged text, before it becomes a definition request. */
interface Draft {
  /** The record this form replaces; empty while adding a new one. */
  editing: string
  name: string
  dialect: HookDialect
  source: 'file' | 'inline'
  configPath: string
  config: string
  pluginRoot: string
  projectDir: string
}

const EMPTY_DRAFT: Draft = {
  editing: '',
  name: '',
  dialect: 'claude-code',
  source: 'inline',
  configPath: '',
  config: '',
  pluginRoot: '',
  projectDir: '',
}

/**
 * Seed the form from a stored record. Inline definitions are not projected back
 * — the record view carries only what the definitions COVER — so editing an
 * inline record starts from an empty document the user re-pastes.
 */
function draftFrom(record: HookRecord): Draft {
  return {
    editing: record.name,
    name: record.name,
    dialect: record.dialect,
    source: record.source,
    configPath: record.configPath ?? '',
    config: '',
    pluginRoot: record.pluginRoot ?? '',
    projectDir: record.projectDir ?? '',
  }
}

/** Parse the inline document, rejecting anything a hook map cannot be. */
function parseConfig(text: string): Record<string, JsonValue> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (_hookDocumentNotJson) {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, JsonValue>
}

/** Build the definition request one draft describes, or undefined when its JSON is not one. */
function toRequest(draft: Draft): HookRecordDefinitionRequest | undefined {
  const shared = {
    mode: draft.editing === '' ? 'create' as const : 'replace' as const,
    name: draft.name.trim(),
    dialect: draft.dialect,
    ...draft.dialect === 'claude-code' && draft.pluginRoot.trim() !== ''
      ? { pluginRoot: draft.pluginRoot.trim() }
      : {},
    ...draft.dialect === 'claude-code' && draft.projectDir.trim() !== ''
      ? { projectDir: draft.projectDir.trim() }
      : {},
  }
  if (draft.source === 'file') return { ...shared, configPath: draft.configPath.trim() }
  const config = parseConfig(draft.config)
  return config === undefined ? undefined : { ...shared, config }
}

/** Whether the draft carries enough for its source to be submitted. */
function submittable(draft: Draft): boolean {
  if (draft.name.trim() === '') return false
  return draft.source === 'file' ? draft.configPath.trim() !== '' : draft.config.trim() !== ''
}

/** Localized one-line status for one record. */
function statusLabel(record: HookRecord, t: (key: PluginsSettingsLocaleKey) => string): string {
  switch (record.status) {
    case 'started': return t('userHooksStarted')
    case 'failed': return t('userHooksFailed')
    case 'invalid': return t('userHooksInvalid')
    default: return t('disabled')
  }
}

/* jscpd:ignore-start -- hook and MCP catalogs intentionally mirror lifecycle controls. */
/**
 * Render the user's own hook records with their write controls.
 * @param props.controls - the Host record operations.
 * @param props.query - the section's shared search text.
 * @param props.t - the section's bound dictionary.
 * @returns the catalog, its add/edit dialog, and any failure notice.
 */
export function HookRecordCatalog({ active = true, controls, query, t }: {
  active?: boolean
  controls: UserHookControls
  query: string
  t: (key: PluginsSettingsLocaleKey) => string
}): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [draft, setDraft] = useState<Draft>()
  const [saving, setSaving] = useState(false)
  const [mutating, setMutating] = useState<string>()
  const [failure, setFailure] = useState<'save' | 'mutate' | 'config' | 'name'>()

  useEffect(() => {
    if (!active) return undefined
    let current = true
    setState({ status: 'loading' })
    void controls.list().then(
      (snapshot) => { if (current) setState({ status: 'ready', snapshot }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [active, controls, request])

  const busy = saving || mutating !== undefined
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const records = state.status === 'ready'
    ? state.snapshot.records.filter(record => normalizedQuery === ''
      || [record.name, record.dialect, record.configPath ?? '', ...record.events]
        .some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
    : []

  const close = (): void => {
    if (saving) return
    setDraft(undefined)
    setFailure(undefined)
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (draft === undefined || !submittable(draft)) return
    if (draft.editing === '' && state.status === 'ready'
      && state.snapshot.records.some(record => record.name === draft.name.trim())) {
      setFailure('name')
      return
    }
    const definition = toRequest(draft)
    if (definition === undefined) {
      setFailure('config')
      return
    }
    setSaving(true)
    setFailure(undefined)
    void controls.define(definition).then(
      (snapshot) => {
        setState({ status: 'ready', snapshot })
        setDraft(undefined)
      },
      () => { setFailure('save') },
    ).finally(() => { setSaving(false) })
  }

  const mutate = (name: string, action: () => Promise<HookRecordSnapshot>): void => {
    setMutating(name)
    setFailure(undefined)
    void action().then(
      (snapshot) => { setState({ status: 'ready', snapshot }) },
      () => { setFailure('mutate') },
    ).finally(() => { setMutating(undefined) })
  }

  return (
    <section className={css.userHooks} aria-label={t('hooksTab')} aria-busy={state.status === 'loading' || busy}>
      <div className={css.userHooksHeading}>
        <Button
          variant="toolbar"
          size="sm"
          icon={<IconPlusOutline16 aria-hidden="true" />}
          disabled={busy}
          onClick={() => { setFailure(undefined); setDraft(EMPTY_DRAFT) }}
        >
          {t('userHooksAdd')}
        </Button>
      </div>
      <p className={css.empty}>{t('userHooksDescription')}</p>
      <p className={css.empty}>{t('userHooksTrust')}</p>
      {state.status === 'loading' ? <p className={css.empty}>{t('userHooksLoading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.userHooksFailure}>
          <p role="alert">{t('userHooksLoadError')}</p>
          <button type="button" onClick={() => { setRequest(value => value + 1) }}>{t('userHooksRetry')}</button>
        </div>
      ) : null}
      {failure === 'mutate' ? <p className={css.empty} role="alert">{t('userHooksMutationError')}</p> : null}
      {state.status === 'ready' && state.snapshot.records.length === 0
        ? <p className={css.empty}>{t('userHooksEmpty')}</p>
        : null}
      {state.status === 'ready' && state.snapshot.records.length > 0 && records.length === 0
        ? <p className={css.empty}>{t('userHooksEmptySearch')}</p>
        : null}
      {records.map(record => (
        <div className={css.userHooksRow} key={record.name} data-user-hook={record.name}>
          <div className={css.userHooksIdentity}>
            <strong>{record.name}</strong>
            <code>{record.source === 'file' ? record.configPath : t('userHooksInlineSource')}</code>
            <span className={css.userHooksStatus}>
              {mutating === record.name ? t('saving') : statusLabel(record, t)}
              {' · '}
              {record.dialect}
            </span>
            {record.detail === undefined ? null : <span className={css.userHooksDetail}>{record.detail}</span>}
            {record.events.length === 0
              ? null
              : (
                <span className={css.userHooksStatus}>
                  {t('userHooksEvents')}: {record.events.join(', ')} ({record.hookCount})
                </span>
              )}
          </div>
          <div className={css.userHooksActions}>
            <label className={css.switchControl}>
              <span>{record.enabled ? t('mcpEnabled') : t('disabled')}</span>
              <Switch
                checked={record.enabled}
                disabled={busy}
                aria-label={`${record.enabled ? t('disable') : t('enable')} ${record.name}`}
                onClick={() => { mutate(record.name, () => controls.setEnabled(record.name, !record.enabled)) }}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { setFailure(undefined); setDraft(draftFrom(record)) }}
            >
              {t('userHooksEdit')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => { mutate(record.name, () => controls.remove(record.name)) }}
            >
              {t('userHooksRemove')}
            </Button>
          </div>
        </div>
      ))}

      <Modal
        open={draft !== undefined}
        onClose={close}
        title={draft?.editing === '' ? t('userHooksAddTitle') : t('userHooksEditTitle')}
        closeLabel={t('userHooksClose')}
        description={t('userHooksFormDescription')}
        footer={(
          <>
            <Button variant="outline" disabled={saving} onClick={close}>{t('userHooksCancel')}</Button>
            <Button
              variant="primary"
              type="submit"
              form="user-hooks-form"
              disabled={saving || draft === undefined || !submittable(draft)}
            >
              {saving ? t('saving') : t('userHooksSave')}
            </Button>
          </>
        )}
      >
        {draft === undefined ? null : (
          <form id="user-hooks-form" className={css.userHooksForm} onSubmit={submit}>
            <label htmlFor="user-hooks-name">{t('userHooksName')}</label>
            <Input
              id="user-hooks-name"
              type="text"
              required
              autoFocus
              value={draft.name}
              placeholder="guardrails"
              // The name is the record's identity; renaming through this form
              // would add a second record rather than move the existing one.
              disabled={saving || draft.editing !== ''}
              onChange={(event) => { setDraft({ ...draft, name: event.currentTarget.value }) }}
            />
            <label htmlFor="user-hooks-dialect">{t('userHooksDialect')}</label>
            <select data-hydra-control="field"
              id="user-hooks-dialect"
              value={draft.dialect}
              disabled={saving}
              onChange={(event) => {
                setDraft({ ...draft, dialect: event.currentTarget.value as HookDialect })
              }}
            >
              <option value="claude-code">{t('userHooksDialectClaudeCode')}</option>
              <option value="codex">{t('userHooksDialectCodex')}</option>
            </select>
            <label htmlFor="user-hooks-source">{t('userHooksSource')}</label>
            <select data-hydra-control="field"
              id="user-hooks-source"
              value={draft.source}
              disabled={saving}
              onChange={(event) => {
                setDraft({ ...draft, source: event.currentTarget.value as Draft['source'] })
              }}
            >
              <option value="inline">{t('userHooksSourceInline')}</option>
              <option value="file">{t('userHooksSourceFile')}</option>
            </select>
            {draft.source === 'file' ? (
              <>
                <label htmlFor="user-hooks-path">{t('userHooksPath')}</label>
                <Input
                  id="user-hooks-path"
                  type="text"
                  required
                  value={draft.configPath}
                  placeholder="C:\\project\\.claude\\hooks.json"
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, configPath: event.currentTarget.value }) }}
                />
              </>
            ) : (
              <>
                <label htmlFor="user-hooks-config">{t('userHooksConfig')}</label>
                <textarea data-hydra-control="field"
                  id="user-hooks-config"
                  rows={8}
                  value={draft.config}
                  placeholder={'{\n  "PreToolUse": [\n    { "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "guard.sh" }] }\n  ]\n}'}
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, config: event.currentTarget.value }) }}
                />
                <p className={css.empty}>{t('userHooksConfigHint')}</p>
              </>
            )}
            {draft.dialect === 'claude-code' ? (
              <>
                <label htmlFor="user-hooks-plugin-root">{t('userHooksPluginRoot')}</label>
                <Input
                  id="user-hooks-plugin-root"
                  type="text"
                  value={draft.pluginRoot}
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, pluginRoot: event.currentTarget.value }) }}
                />
                <label htmlFor="user-hooks-project-dir">{t('userHooksProjectDir')}</label>
                <Input
                  id="user-hooks-project-dir"
                  type="text"
                  value={draft.projectDir}
                  disabled={saving}
                  onChange={(event) => { setDraft({ ...draft, projectDir: event.currentTarget.value }) }}
                />
              </>
            ) : null}
            {failure === 'config' ? <p className={css.saveFailed} role="alert">{t('userHooksConfigInvalid')}</p> : null}
            {failure === 'save' ? <p className={css.saveFailed} role="alert">{t('userHooksSaveError')}</p> : null}
            {failure === 'name' ? <p className={css.saveFailed} role="alert">{t('userHooksNameTaken')}</p> : null}
          </form>
        )}
      </Modal>
    </section>
  )
}
/* jscpd:ignore-end */
