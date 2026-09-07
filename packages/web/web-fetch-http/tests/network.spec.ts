import { createServer } from 'node:http'
import { lookup, type LookupAddress, type LookupAllOptions } from 'node:dns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpFetchProvider } from '../src/provider.ts'
import { assertPublicAddress, resolveAllowedOrigins } from '../src/network.ts'

vi.mock('node:dns', () => ({ lookup: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const limits = { maxUrlLength: 2048, maxResponseBytes: 1024, maxBodyChars: 1024, timeoutMs: 1000, maxRedirects: 3, userAgent: 'test' }

describe('public fetch destinations', () => {
  it.each(['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '192.0.0.9', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1',
    '64:ff9b::7f00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'invalid'])('rejects %s', (address) => {
    expect(() => { assertPublicAddress(address) }).toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts %s', (address) => {
    expect(() => { assertPublicAddress(address) }).not.toThrow()
  })

  it.each(['http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://[::1]', 'http://[::ffff:127.0.0.1]'])('blocks normalized literal %s', async (url) => {
    await expect(new HttpFetchProvider(limits).fetch({ url })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
  ])('blocks private DNS answers inside connect before reaching the server: %j', async (...addresses) => {
    let requests = 0
    const server = createServer((_req, res) => { requests++; res.end('private') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const resolve = (_host: string, _options: LookupAllOptions, callback: (error: null, result: LookupAddress[]) => void): void => {
        callback(null, addresses)
      }
      vi.mocked(lookup).mockImplementation(resolve as typeof lookup)
      await expect(new HttpFetchProvider(limits).fetch({ url: `http://public.example:${address.port}` }))
        .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
      expect(requests).toBe(0)
      expect(lookup).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  })

  it('requires exact operator-granted origins', () => {
    expect(resolveAllowedOrigins(['http://localhost:43117/'])).toEqual(['http://localhost:43117'])
    for (const origin of ['file:///x', 'https://*.example.com', 'https://user:pw@example.com', 'http://localhost/a', 'http://localhost/?x']) {
      expect(() => resolveAllowedOrigins([origin])).toThrow()
    }
  })

  it('does not grant other ports or origins through an exception', async () => {
    const provider = new HttpFetchProvider({ ...limits, allowedOrigins: ['http://127.0.0.1:43117'] })
    await expect(provider.fetch({ url: 'http://127.0.0.1:43118' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })
})
