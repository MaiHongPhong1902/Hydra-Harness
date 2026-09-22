// @vitest-environment jsdom
/** Credential acknowledgement and draft isolation in the optional provider card. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { JevProviderOption } from '../src/client/JevProviderOption.tsx'

afterEach(cleanup)

it('contributes a native option for the Models provider select', () => {
  render(<JevProviderOption
    mode="option"
    useSessions={() => { throw new Error('unused') }}
    useWorkspaces={() => { throw new Error('unused') }}
    useSettings={(() => ({ status: 'ready' as const, error: null, view: undefined })) as never}
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
