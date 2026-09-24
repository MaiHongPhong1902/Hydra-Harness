import type { LookupAddress, LookupAllOptions } from 'node:dns'
import type { LookupFunction } from 'node:net'
import { Agent } from 'undici'
import { afterEach, expect, it, vi } from 'vitest'
import { publicDispatcher } from '../src/network.ts'

const lookup = vi.hoisted(() => vi.fn<(
  hostname: string,
  options: LookupAllOptions,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void>())
vi.mock('node:dns', () => ({ lookup }))
vi.mock('undici', () => ({ Agent: vi.fn(function () {}) }))
afterEach(() => vi.resetAllMocks())

it.each([
  { all: true, addresses: [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }] },
  { all: false, addresses: [{ address: '8.8.8.8', family: 4 }] },
])('passes validated DNS answers to the socket (all=$all)', ({ all, addresses }) => {
  publicDispatcher(new URL('https://public.example'), [])
  const options = vi.mocked(Agent).mock.calls[0]![0]!
  const connect = options.connect as { lookup: LookupFunction }
  const callback = vi.fn()
  connect.lookup('public.example', { all }, callback)
  const dnsCallback = lookup.mock.calls[0]![2]
  dnsCallback(null, addresses)
  expect(lookup).toHaveBeenCalledWith('public.example', { all: true, order: 'verbatim' }, expect.any(Function))
  expect(callback).toHaveBeenCalledWith(null, all ? addresses : addresses[0]!.address, all ? undefined : 4)
})

it.each(['resolver-error', 'empty-answers'] as const)('rejects DNS lookup failure: %s', (failure) => {
  publicDispatcher(new URL('https://public.example'), [])
  const options = vi.mocked(Agent).mock.calls[0]![0]!
  const connect = options.connect as { lookup: LookupFunction }
  const callback = vi.fn()
  connect.lookup('public.example', {}, callback)
  const dnsCallback = lookup.mock.calls[0]![2]
  const error = failure === 'resolver-error' ? new Error('DNS unavailable') : null
  dnsCallback(error, [])
  expect(callback).toHaveBeenCalledWith(error ?? expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }), [], undefined)
})
