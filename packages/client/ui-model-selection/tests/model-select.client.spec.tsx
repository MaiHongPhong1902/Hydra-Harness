// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@hydraharness/harness-api-remotes/client'
import type { SettingsNamespaceView } from '@hydraharness/harness-api-remotes/client'
import type { SettingsMirrorSnapshot } from '@hydraharness/harness-client-ui-settings/client'
import { createSnapshotStore } from '@hydraharness/harness-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@hydraharness/harness-client-locale/src/locales/en.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key]
    ?? (commonEn as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

it('synchronizes global generation choices with the settings mirror and preserves provider identity', async () => {
  const namespace = { ns: 'llm-pi-ai', revision: 7, value: { videoModel: { provider: 'first', model: 'video' } },
    schema: {}, secrets: [] } as unknown as SettingsNamespaceView
  const mirror = createSnapshotStore<SettingsMirrorSnapshot>({ status: 'ready', error: null,
    view: { writable: true, hasDocument: true, namespaces: [namespace] } })
  const settings = { ...mirror, ensure: async () => {}, acceptView: (view: SettingsNamespaceView) => {
    mirror.set({ ...mirror.getSnapshot(), view: { writable: true, hasDocument: true, namespaces: [view] } })
  } }
  const groups = ['first', 'second'].map(id => ({ id, name: id, models: [
    { id: 'same', name: 'Same', endpoints: ['images/generations'] },
    { id: 'video', name: 'Video', endpoints: ['videos'] },
    { id: 'text', name: 'Text', endpoints: ['chat/completions'] },
  ] }))
  const mutate = vi.fn(async () => ({ result: { ok: true, value: { ...namespace, revision: 8,
    value: { ...namespace.value as object, imageModel: { provider: 'second', model: 'same' } } } } }))
  const api = { llm: { models: async () => ({ result: { ok: true, value: { groups, failures: [] } } }) }, settings: { mutate } } as never
  render(<ModelSelect locked={false} available directory={createSnapshotStore(state())} load={vi.fn()}
    select={vi.fn()} t={t} generation={{ settings, api }} />)
  fireEvent.click(screen.getByRole('button', { name: /Select model, current/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Image model/ }))
  const group = await screen.findByRole('group', { name: 'second (second)' })
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
  expect(screen.queryByRole('menuitemradio', { name: 'Text' })).toBeNull()
  expect(screen.queryByRole('menuitemradio', { name: 'Video' })).toBeNull()
  fireEvent.click(group.querySelector('button')!)
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  expect(mutate).toHaveBeenCalledWith({ ns: 'llm-pi-ai', expectedRevision: 7,
    ops: [{ op: 'set', path: ['imageModel'], value: { provider: 'second', model: 'same' } }] })
  fireEvent.click(screen.getByRole('button', { name: /Select model, current/ }))
  expect((await screen.findByRole('menuitem', { name: /Image model/ })).textContent).toBe('Image modelSame')
  expect(screen.getByRole('menuitem', { name: /Video model/ }).textContent).toBe('Video modelVideo')
  settings.acceptView({ ...namespace, revision: 9, value: { imageModel: { provider: 'first', model: 'text' } } })
  await waitFor(() => { expect(screen.getByRole('menuitem', { name: /Image model/ }).textContent).toBe('Image modelText') })
  expect(screen.getByRole('menuitem', { name: /Video model/ }).textContent).toContain('Automatic fallback')
  fireEvent.click(screen.getByRole('menuitem', { name: /Video model/ }))
  await screen.findAllByRole('menuitemradio', { name: 'Video' })
  expect(screen.queryByRole('menuitemradio', { name: 'Same' })).toBeNull()
  expect((await screen.findByRole('menuitemradio', { name: 'Automatic fallback' })).getAttribute('aria-checked')).toBe('true')
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.getByRole('menuitem', { name: /Image model/ })).toBeTruthy()
})

it('keeps a rejected generation write open with its previous durable selection', async () => {
  const mirror = createSnapshotStore<SettingsMirrorSnapshot>({ status: 'ready', error: null,
    view: { writable: true, hasDocument: true, namespaces: [{ ns: 'llm-pi-ai', revision: 4, value: {}, schema: {}, secrets: [] } as unknown as SettingsNamespaceView] } })
  const acceptView = vi.fn()
  const models = vi.fn(async () => ({ result: { ok: true, value: { groups: [], failures: [] } } }))
  render(<ModelSelect locked={false} available directory={createSnapshotStore(state())} load={vi.fn()} select={vi.fn()} t={t}
    generation={{ settings: { ...mirror, ensure: async () => {}, acceptView },
      api: { llm: { models }, settings: { mutate: async () => ({ result: { ok: false, error: { message: 'Revision changed' } } }) } } as never }} />)
  fireEvent.click(screen.getByRole('button', { name: /Select model, current/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: /Video model/ }))
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Automatic fallback' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Revision changed')
  expect(acceptView).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
})

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: 'Select model, current DeepSeek-V4-Flash, reasoning effort High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('Select model, current DeepSeek-V4-Flash, reasoning effort Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Select model, current Model, reasoning effort Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: 'Select model' })
    expect(trigger.textContent).toContain('Select model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /Effort/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /Select model|current/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('Model operation failed: model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
