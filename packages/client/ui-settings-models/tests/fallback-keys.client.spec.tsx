// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CredentialView, IApiClient, RpcResponse } from '@hydraharness/harness-api-remotes/client'
import { FallbackKeysEditor, useFallbackKeys } from '../src/client/FallbackKeysEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const ref = 'OPENAI_API_KEY_FALLBACK_12345678_1234_1234_1234_123456789ABC'
const t = (key: keyof typeof en): string => en[key]
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'keys-test' as never, result: { ok: true, value } }
}
function failed(): RpcResponse<never> {
  return { rpcId: 'keys-test' as never, result: { ok: false, error: { code: 'write-failed', message: 'retry deletion', details: {} } as never } }
}
function api() {
  return { credentials: {
    describe: vi.fn(() => Promise.resolve(ok<{ credentials: Record<string, CredentialView> }>({
      credentials: { [ref]: { configured: true, writable: true } },
    }))),
    set: vi.fn(() => Promise.resolve(ok({}))),
    unset: vi.fn(() => Promise.resolve(ok({}))),
  } }
}

it('keeps deletion retryable and handles unreadable credential hints', async () => {
  const wire = api()
  wire.credentials.unset.mockResolvedValueOnce(failed())
  const { result } = renderHook(() => useFallbackKeys({ apiKeyFallbackEnvs: [ref] }, 'openai', wire))
  await waitFor(() => { expect(result.current.states[ref]?.writable).toBe(true) })
  act(() => { result.current.remove(ref) })
  let error: string | undefined
  await act(async () => { error = await result.current.save() })
  expect(error).toBe('retry deletion')
  await act(async () => { expect(await result.current.save()).toBeUndefined() })
  expect(wire.credentials.unset).toHaveBeenCalledTimes(2)
  cleanup()
  wire.credentials.describe.mockRejectedValue(new Error('offline'))
  renderHook(() => useFallbackKeys({ apiKeyFallbackEnvs: [ref] }, 'openai', wire))
  await act(async () => { await Promise.resolve() })
})

it('deletes a key acknowledged earlier in the same draft even when describe is unavailable', async () => {
  const wire = api()
  wire.credentials.describe.mockResolvedValue(ok({ credentials: {} }))
  const { result } = renderHook(() => useFallbackKeys(undefined, 'openai', wire as unknown as IApiClient))
  act(() => { result.current.add() })
  const key = result.current.refs[0]!
  act(() => { result.current.edit(key, 'saved-key') })
  await act(async () => { await result.current.save() })
  act(() => { result.current.remove(key) })
  await act(async () => { await result.current.save() })
  expect(wire.credentials.unset).toHaveBeenCalledWith({ ref: key })
})

it('shows environment keys as locked and validates malformed fallback values', async () => {
  const wire = api()
  wire.credentials.describe.mockResolvedValue(ok({ credentials: { [ref]: { configured: true, writable: false } } }))
  function Editor() {
    const keys = useFallbackKeys({ apiKeyFallbackEnvs: [ref] }, 'openai', wire)
    return <FallbackKeysEditor keys={keys} disabled={false} t={t} />
  }
  render(<Editor />)
  const input = screen.getByLabelText<HTMLInputElement>(`${en.fallbackKey} 1`)
  await waitFor(() => { expect(input.disabled).toBe(true) })
  expect(input.placeholder).toBe(en.keyEnvLocked)
  fireEvent.click(screen.getByText(en.addKey))
  fireEvent.change(screen.getByLabelText(`${en.fallbackKey} 2`), { target: { value: 'not a key' } })
  expect(screen.getByText(en.keyIllegalCharacters)).toBeTruthy()
  fireEvent.click(screen.getByLabelText(`${en.removeKey} 1`))
  expect(screen.queryByPlaceholderText(en.keyEnvLocked)).toBeNull()
})
