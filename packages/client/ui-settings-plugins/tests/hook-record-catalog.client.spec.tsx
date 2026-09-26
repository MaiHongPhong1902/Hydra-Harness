// @vitest-environment jsdom
/**
 * The user's own hook records as the Plugins hooks tab renders them: what a
 * save sends, what a refused document reads as, and what the tab shows when the
 * connection is not local.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HookRecordSnapshot } from '@hydra1902/harness-api-remotes/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HookRecordCatalog, type UserHookControls } from '../src/client/HookRecordCatalog.tsx'
import { HooksSettingsTab, type HooksSettingsTabProps } from '../src/client/HooksSettingsTab.tsx'
import { en, type PluginsSettingsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: PluginsSettingsLocaleKey): string => en[key]

const EMPTY: HookRecordSnapshot = { records: [] }
const STORED: HookRecordSnapshot = {
  records: [{
    name: 'guardrails',
    dialect: 'claude-code',
    source: 'inline',
    enabled: false,
    status: 'stopped',
    events: [],
    hookCount: 0,
  }],
}
const ACTIVE: HookRecordSnapshot = {
  records: [{ ...STORED.records[0]!, enabled: true, status: 'started', events: ['PreToolUse'], hookCount: 1 }],
}

function controls(overrides: Partial<UserHookControls> = {}): UserHookControls {
  return {
    list: vi.fn(async () => EMPTY),
    define: vi.fn(async () => STORED),
    setEnabled: vi.fn(async () => ACTIVE),
    remove: vi.fn(async () => EMPTY),
    ...overrides,
  }
}

describe('HookRecordCatalog', () => {
  it.each([false, true])('loads only while active and ignores late responses (reject: %s)', async (reject) => {
    const pending = Promise.withResolvers<HookRecordSnapshot>()
    const face = controls({ list: vi.fn(() => pending.promise) })
    const view = render(<HookRecordCatalog active={false} controls={face} query="" t={t} />)
    expect(face.list).not.toHaveBeenCalled()
    view.rerender(<HookRecordCatalog active controls={face} query="" t={t} />)
    expect(face.list).toHaveBeenCalledOnce()
    view.unmount()
    await act(async () => { if (reject) pending.reject(new Error('closed')); else pending.resolve(EMPTY) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retries loading, filters file and inline records, and reports a refused mutation', async () => {
    const snapshot: HookRecordSnapshot = { records: [...STORED.records, { ...STORED.records[0]!, name: 'project', status: 'failed',
      source: 'file', configPath: '/project/hooks.json', pluginRoot: '/plugin', projectDir: '/project' }] }
    const face = controls({ list: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot),
      remove: vi.fn().mockRejectedValue(new Error('refused')) })
    const view = render(<HookRecordCatalog controls={face} query="" t={t} />)
    await screen.findByText(en.userHooksLoadError)
    fireEvent.click(screen.getByRole('button', { name: en.userHooksRetry }))
    await screen.findByText('project')
    view.rerender(<HookRecordCatalog controls={face} query="hooks.json" t={t} />)
    expect(screen.queryByText('guardrails')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.userHooksEdit }))
    expect(screen.getByLabelText(en.userHooksPluginRoot)).toHaveProperty('value', '/plugin')
    fireEvent.change(screen.getByLabelText(en.userHooksPluginRoot), { target: { value: '/replacement' } })
    fireEvent.click(screen.getByRole('button', { name: en.userHooksCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.userHooksRemove }))
    await screen.findByText(en.userHooksMutationError)
    view.rerender(<HookRecordCatalog controls={face} query="absent" t={t} />)
    expect(screen.getByText(en.userHooksEmptySearch)).not.toBeNull()
  })

  it('keeps a pending save open and rejects an empty form submission', async () => {
    const pending = Promise.withResolvers<HookRecordSnapshot>()
    const face = controls({ define: vi.fn(() => pending.promise) })
    render(<HookRecordCatalog controls={face} query="" t={t} />)
    await screen.findByText(en.userHooksEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userHooksAdd }))
    fireEvent.submit(document.getElementById('user-hooks-form')!)
    expect(face.define).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(en.userHooksName), { target: { value: 'new' } })
    fireEvent.change(screen.getByLabelText(en.userHooksConfig), { target: { value: '{}' } })
    fireEvent.change(screen.getByLabelText(en.userHooksPluginRoot), { target: { value: '/plugin' } })
    fireEvent.click(screen.getByRole('button', { name: en.userHooksSave }))
    fireEvent.click(screen.getByRole('button', { name: en.userHooksClose }))
    expect(screen.getByRole('dialog')).not.toBeNull()
    await act(async () => { pending.resolve(STORED) })
    expect(face.define).toHaveBeenCalledWith(expect.objectContaining({ pluginRoot: '/plugin' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps an existing active hook untouched when Add repeats its name', async () => {
    const face = controls({ list: vi.fn(async () => ACTIVE) })
    render(<HookRecordCatalog controls={face} query="" t={t} />)
    await screen.findByText('guardrails')
    fireEvent.click(screen.getByRole('button', { name: en.userHooksAdd }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(en.userHooksName), { target: { value: ' guardrails ' } })
    fireEvent.change(within(dialog).getByLabelText(en.userHooksConfig), { target: { value: '{}' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userHooksSave }))
    expect(within(dialog).getByRole('alert').textContent).toBe(en.userHooksNameTaken)
    expect(face.define).not.toHaveBeenCalled()
    expect(screen.getByRole('switch', { name: `${en.disable} guardrails` }).getAttribute('aria-checked')).toBe('true')
  })
  it('saves inline definitions with their substitution roots', async () => {
    const face = controls()
    render(<HookRecordCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userHooksEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userHooksAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userHooksAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksName }), { target: { value: ' guardrails ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksConfig }), {
      target: { value: '{"Stop":[{"hooks":[{"type":"command","command":"notify.sh"}]}]}' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksProjectDir }), {
      target: { value: ' C:\\project ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userHooksSave }))

    await waitFor(() => {
      expect(face.define).toHaveBeenCalledWith({
        mode: 'create',
        name: 'guardrails',
        dialect: 'claude-code',
        projectDir: 'C:\\project',
        config: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] },
      })
    })
  })

  it('saves a file record by path and drops the claude-code-only roots for codex', async () => {
    const face = controls()
    render(<HookRecordCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userHooksEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userHooksAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userHooksAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksName }), { target: { value: 'project' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: en.userHooksDialect }), { target: { value: 'codex' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: en.userHooksSource }), { target: { value: 'file' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksPath }), {
      target: { value: ' C:\\project\\hooks.json ' },
    })
    // The substitution-root fields belong to claude-code and are not rendered here.
    expect(within(dialog).queryByRole('textbox', { name: en.userHooksProjectDir })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en.userHooksSave }))

    await waitFor(() => {
      expect(face.define).toHaveBeenCalledWith({
        mode: 'create',
        name: 'project',
        dialect: 'codex',
        configPath: 'C:\\project\\hooks.json',
      })
    })
  })

  it.each(['[1,2]', 'null', '{bad'])('blocks a non-object hook document: %s', async (document) => {
    const face = controls()
    render(<HookRecordCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userHooksEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userHooksAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userHooksAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksName }), { target: { value: 'guardrails' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksConfig }), { target: { value: document } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userHooksSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.userHooksConfigInvalid)
    expect(face.define).not.toHaveBeenCalled()
  })

  it('reports a refused save without closing the dialog', async () => {
    const face = controls({ define: vi.fn(async () => { throw new Error('refused') }) })
    render(<HookRecordCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userHooksEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userHooksAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userHooksAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksName }), { target: { value: 'guardrails' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userHooksConfig }), { target: { value: '{}' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userHooksSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.userHooksSaveError)
    expect(screen.getByRole('dialog', { name: en.userHooksAddTitle })).toBeTruthy()
  })

  it('toggles and removes one record, showing what its definitions cover', async () => {
    const face = controls({ list: vi.fn(async () => STORED) })
    render(<HookRecordCatalog controls={face} query="" t={t} />)

    fireEvent.click(await screen.findByRole('switch', { name: `${en.enable} guardrails` }))
    await waitFor(() => { expect(face.setEnabled).toHaveBeenCalledWith('guardrails', true) })
    expect(await screen.findByText(`${en.userHooksEvents}: PreToolUse (1)`)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.userHooksRemove }))
    await waitFor(() => { expect(face.remove).toHaveBeenCalledWith('guardrails') })
    expect(await screen.findByText(en.userHooksEmpty)).toBeTruthy()
  })

  it('shows the reason a stored record could not be read', async () => {
    const invalid: HookRecordSnapshot = {
      records: [{
        ...STORED.records[0]!,
        enabled: true,
        status: 'invalid',
        detail: 'hookRecords: record project document is not valid JSON',
      }],
    }
    render(<HookRecordCatalog controls={controls({ list: vi.fn(async () => invalid) })} query="" t={t} />)

    expect(await screen.findByText('hookRecords: record project document is not valid JSON')).toBeTruthy()
  })

  it('pins the name on an edit and starts its inline document empty', async () => {
    const face = controls({ list: vi.fn(async () => STORED) })
    render(<HookRecordCatalog controls={face} query="" t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: en.userHooksEdit }))
    const dialog = screen.getByRole('dialog', { name: en.userHooksEditTitle })
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.userHooksName }).disabled).toBe(true)
    expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: en.userHooksConfig }).value).toBe('')
    fireEvent.change(within(dialog).getByLabelText(en.userHooksConfig), { target: { value: '{}' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userHooksSave }))
    await waitFor(() => { expect(face.define).toHaveBeenCalledWith({ mode: 'replace', name: 'guardrails', dialect: 'claude-code', config: {} }) })
  })
})

describe('HooksSettingsTab', () => {
  it('says the surface is local-only without controls', () => {
    render(<HooksSettingsTab {...({ active: true, query: '', t, renderSlot: () => null } as unknown as HooksSettingsTabProps)} />)

    expect(screen.getByText(en.userHooksUnavailable)).toBeTruthy()
  })

  it('renders the catalog when the Host serves it', async () => {
    render(<HooksSettingsTab
      {...({ active: true, query: '', t, renderSlot: () => null, userHooks: controls() } as unknown as HooksSettingsTabProps)}
    />)

    expect(await screen.findByRole('region', { name: en.hooksTab })).toBeTruthy()
    expect(await screen.findByText(en.userHooksEmpty)).toBeTruthy()
  })
})
