/**
 * Package-owned invariant companion for `@hydraharness/harness-mcp-registry`.
 * @module @hydraharness/harness-mcp-registry/invariant
 */

import type { Context } from '@hydraharness/cordis'
import type { InvariantFailure, InvariantInstaller } from '@hydraharness/harness-invariants'
import type { McpServerSnapshot } from './types.ts'

const PACKAGE_NAME = '@hydraharness/harness-mcp-registry'

/** Cordis companion plugin name. */
export const name = 'mcp-registry-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * The registry's contract is that the mounted set follows the stored records
 * once reconciliation settles: an enabled record it accepted is live, and a
 * disabled one is not. Both sides ride the reconciliation event, so the check
 * observes the authoritative projection rather than re-deriving it.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('mcp-servers/reconciled', (snapshot: McpServerSnapshot) => {
    for (const server of snapshot.servers) {
      if (server.enabled && server.status === 'stopped') {
        fail(`enabled MCP server ${JSON.stringify(server.name)} has no live mount after reconciliation`)
      }
      if (!server.enabled && server.status !== 'stopped') {
        fail(`disabled MCP server ${JSON.stringify(server.name)} still reports ${server.status}`)
      }
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
