/** Public-destination enforcement at socket lookup; explicit origins may reach private services. */
import { lookup } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent } from 'undici'
import { WebError } from '@hydra/harness-web'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(address, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

/**
 * Reject special-use addresses, including mapped IPv4 and IPv6 transition ranges.
 * @param address - a literal IP address from URL parsing or the system resolver.
 * @throws {WebError} when the address is not public unicast.
 */
export function assertPublicAddress(address: string): void {
  const family = isIP(address)
  const publicAddress = family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
  if (!publicAddress) throw new WebError('web fetch destination is not a public IP address', 'WEB_BLOCKED_URL')
}

/**
 * Validate operator-granted exact origins; paths, credentials and wildcards are rejected.
 * @param origins - configured exceptions to public-only destination enforcement.
 * @returns canonical origins used for exact comparison on every redirect.
 */
export function resolveAllowedOrigins(origins: readonly string[]): readonly string[] {
  return origins.map((origin) => {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
      throw new Error('web-fetch-http: allowedOrigins must contain exact HTTP(S) origins without credentials, paths, or wildcards')
    }
    return url.origin
  })
}

/** Resolve once inside connect and pass only that validated address set to the socket. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => {
    if (error) { callback(error, [], undefined); return }
    try {
      if (addresses.length === 0) throw new WebError('web fetch DNS returned no addresses', 'WEB_PROVIDER_ERROR')
      for (const entry of addresses) assertPublicAddress(entry.address)
    } catch (failure) {
      callback(failure as Error, [], undefined)
      return
    }
    const first = addresses[0] as { address: string; family: number }
    if (options.all) callback(null, addresses, undefined)
    else callback(null, first.address, first.family)
  })
}

/**
 * Create a direct dispatcher, independent of ambient proxies or global dispatchers.
 * @param url - validated request URL.
 * @param allowedOrigins - operator-granted exceptions, never model-controlled.
 * @returns dispatcher the caller must destroy after consuming or cancelling the response.
 */
export function publicDispatcher(url: URL, allowedOrigins: readonly string[]): Agent {
  if (allowedOrigins.includes(url.origin)) return new Agent()
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) assertPublicAddress(hostname)
  return new Agent({ connect: { lookup: publicLookup } })
}
