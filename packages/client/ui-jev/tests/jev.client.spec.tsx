// @vitest-environment jsdom
/** Credential acknowledgement and draft isolation in the optional provider card. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { JevProviderOption } from '../src/client/JevProviderOption.tsx'
import { apply } from '../src/client/index.ts'

afterEach(cleanup)

it('contributes a native option for the Models provider select', () => {
  render(<JevProviderOption
    mode="option"
    useSessions={() => { throw new Error('unused') }}
    useWorkspaces={() => { throw new Error('unused') }}
    useSettings={((select: (value: unknown) => unknown) => select({ status: 'ready', error: null, view: undefined })) as never}
    saveKey={async () => true}
  />)
  expect(screen.getByRole('option', { name: 'Jev' }).getAttribute('data-hydra-provider-option')).toBe('jev')
})

it('uses the Host credential reference and closes only after successful acknowledgement', async () => {
  const saveKey = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const onClose = vi.fn()
  const props = {
    mode: 'editor' as const, readOnly: false, onClose, saveKey,
    useSessions: (() => { throw new Error('unused') }) as never,
    useWorkspaces: (() => { throw new Error('unused') }) as never,
    useSettings: (() => ({ status: 'ready' as const, error: null, view: {
      writable: true, hasDocument: true,
      namespaces: [{ ns: 'jev', value: { apiKeyEnv: 'CUSTOM_JEV_KEY', model: 'jev-test' } }],
    } })) as never,
  }
  render(<JevProviderOption {...props} />)
  expect(screen.getByText('Model: jev-test')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'fixture-secret' } })
  fireEvent.click(screen.getByText('Apply'))
  await screen.findByRole('alert')
  expect(onClose).not.toHaveBeenCalled()
  expect(saveKey).toHaveBeenCalledWith('CUSTOM_JEV_KEY', 'fixture-secret')
  fireEvent.click(screen.getByText('Apply'))
  await waitFor(() => { expect(onClose).toHaveBeenCalledWith(true) })
  expect(screen.getByLabelText<HTMLInputElement>('API key').value).toBe('')
})

it('registers the provider slot and saves through the connection API', async () => {
  const register = vi.fn()
  const inject = vi.fn((_: string, factory: () => unknown) => factory())
  const describe = vi.fn(() => ({ status: 'ready', error: null, view: undefined }))
  const set = vi.fn().mockResolvedValueOnce({ result: { ok: true } }).mockResolvedValueOnce({ result: { ok: false } })
  const ctx = {
    get: () => ({ api: { credentials: { set } } }),
    settingsScope: { describe }, slots: { inject, register },
  }
  apply(ctx as never)
  expect(inject).toHaveBeenCalledWith('settings.models.provider-option', expect.any(Function))
  const spec = register.mock.calls[0]?.[0] as { inject: () => { saveKey: (ref: string, value: string) => Promise<boolean> } }
  await expect(spec.inject().saveKey('JEV_KEY', 'secret')).resolves.toBe(true)
  expect(set).toHaveBeenCalledWith({ ref: 'JEV_KEY', value: 'secret' })
  await expect(spec.inject().saveKey('JEV_KEY', 'secret')).resolves.toBe(false)
})

it.each([
  ['loading', 'Loading Jev settings…'],
  ['error', 'Jev provider settings are unavailable. Check Plugins.'],
] as const)('shows the %s settings state', (status, text) => {
  render(<JevProviderOption
    mode="editor" readOnly={false} onClose={vi.fn()} saveKey={vi.fn()}
    useSessions={() => { throw new Error('unused') }}
    useWorkspaces={() => { throw new Error('unused') }}
    useSettings={(() => ({ status, error: status === 'error' ? new Error('offline') : null, view: undefined })) as never}
  />)
  expect(screen.getByRole('status').textContent).toBe(text)
})

it('validates an empty key, ignores read-only saves, and reports wire failures', async () => {
  const onClose = vi.fn()
  const saveKey = vi.fn().mockRejectedValue(new Error('network'))
  const props = {
    mode: 'editor' as const, readOnly: false, onClose, saveKey,
    useSessions: (() => { throw new Error('unused') }) as never,
    useWorkspaces: (() => { throw new Error('unused') }) as never,
    useSettings: (() => ({ status: 'ready' as const, error: null, view: {
      writable: true, hasDocument: true,
      namespaces: [{ ns: 'jev', value: { apiKeyEnv: 'JEV_KEY', model: 'jev-test' } }],
    } })) as never,
  }
  render(<JevProviderOption {...props} />)
  fireEvent.click(screen.getByText('Apply'))
  expect((await screen.findByRole('alert')).textContent).toBe('Enter a Jev API key.')
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByText('Apply'))
  expect((await screen.findByRole('alert')).textContent).toBe('Jev credential could not be saved.')
  expect(onClose).not.toHaveBeenCalled()
  cleanup()
  render(<JevProviderOption {...props} readOnly />)
  expect(screen.getByLabelText<HTMLInputElement>('API key').disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByText('Apply'))
  expect(saveKey).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByText('Cancel'))
  expect(onClose).toHaveBeenCalledWith(false)
})
