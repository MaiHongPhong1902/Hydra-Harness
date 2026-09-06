/**
 * TypeScript client SDK for the Hydra harness runtime: spawn the
 * `bh-jsonrpc-agent` runtime as a subprocess and drive agent turns over
 * stdio JSON-RPC. `HydraHarness` is the high-level run API;
 * `HarnessClient` is the lower-level protocol client. A pure library — it
 * registers nothing on a Cordis context; the runtime process it spawns is a
 * complete harness configured by its own `cordis.yml`.
 *
 * @module @hydra/harness-sdk-client
 */

export { HydraHarness, HarnessSession } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@hydra/harness-sdk-protocol'
export type {
  ContentBlock,
  HydraHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'
