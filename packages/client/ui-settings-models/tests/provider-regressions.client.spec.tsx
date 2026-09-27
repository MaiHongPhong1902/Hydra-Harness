// @vitest-environment jsdom
/** Provider retries and probes after removing stored overrides. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@hydra1902/schemastery'
import type { RpcResponse } from '@hydra1902/harness-api-remotes/client'
import { CustomProviderCard } from '../src/client/CustomProviderCard.tsx'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import { settingsSchema } from './settings-schema.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const ok = <T,>(value: T): RpcResponse<T> => ({ rpcId: 'provider-regression' as never, result: { ok: true, value } })
const t = (key: keyof typeof en) => en[key]

it('retries only the credential after its committed provider appears in the directory', async () => {
  const set = vi.fn().mockResolvedValueOnce({
    rpcId: 'key', result: { ok: false, error: { code: 'internal', message: 'key write refused' } },
  }).mockResolvedValueOnce(ok({}))
  const mutate = vi.fn().mockResolvedValue(ok({ revision: 8 }))
  const props = {
    taken: [] as string[], protocols: ['openai-completions'], revision: 7,
    api: { settings: { mutate }, credentials: { set }, llm: {} } as never,
    t, readOnly: false, onClose: vi.fn(),
  }
  const view = render(<CustomProviderCard {...props} />)
  fireEvent.change(screen.getByLabelText(en.customRoute), { target: { value: 'fixture-provider' } })
  fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://example.invalid/v1' } })
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'fixture-key' } })
  fireEvent.click(screen.getByRole('button', { name: en.addModel }))
  fireEvent.change(screen.getByLabelText(`${en.modelId} 1`), { target: { value: 'fixture-model' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))
  await screen.findByText('key write refused')
  view.rerender(<CustomProviderCard {...props} taken={['fixture-provider']} revision={8} />)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.create }).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'replacement-key' } })
  fireEvent.click(screen.getByRole('button', { name: en.create }))
  await waitFor(() => { expect(props.onClose).toHaveBeenCalledWith(true) })
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(set).toHaveBeenCalledTimes(2)
  expect(set).toHaveBeenLastCalledWith({ ref: 'FIXTURE_PROVIDER_API_KEY', value: 'replacement-key' })
})

it.each(['base', 'default', 'absent'] as const)('probes cleared endpoint and proxy overrides using %s inheritance', async (inheritance) => {
  const profile = Schema.object({
    baseURL: inheritance === 'default' ? Schema.string().default('https://default.invalid/v1') : Schema.string(),
    proxy: Schema.string(), api: Schema.string(),
  })
  const config = Schema.object({ providers: Schema.dict(profile) })
  const discoverModels = vi.fn().mockResolvedValue(ok({ models: [] }))
  const inherited = inheritance === 'base'
    ? { baseURL: 'https://inherited.invalid/v1', proxy: 'http://inherited.invalid:8080' } : {}
  render(<ProviderEditor
    provider="fixture-provider" displayName="Fixture" settingsPath={['providers', 'fixture-provider']}
    namespace={{
      ns: 'llm-pi-ai', schema: config.toJSON(), revision: 1, applies: 'live', secrets: [],
      user: { providers: { 'fixture-provider': { baseURL: 'https://old.invalid/v1', proxy: 'http://old.invalid:8080' } } },
      value: { providers: { 'fixture-provider': { baseURL: 'https://old.invalid/v1', proxy: 'http://old.invalid:8080' } } },
      base: { providers: { 'fixture-provider': inherited } },
    }}
    schema={settingsSchema} t={t} readOnly={false} onClose={vi.fn()}
    api={{ credentials: { describe: () => Promise.resolve(ok({ credentials: {} })) }, llm: { discoverModels } } as never}
  />)
  fireEvent.click(screen.getByText(en.customized))
  fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText(en.proxy), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: en.fetchModels }))
  await waitFor(() => { expect(discoverModels).toHaveBeenCalledTimes(1) })
  expect(discoverModels.mock.calls[0]?.[0]).toEqual({
    settingsNs: 'llm-pi-ai', provider: 'fixture-provider',
    ...inherited,
    ...inheritance === 'default' ? { baseURL: 'https://default.invalid/v1' } : {},
  })
})
