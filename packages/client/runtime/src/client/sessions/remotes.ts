/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @hydra1902/harness-client-runtime/client/sessions/remotes
 */

import type { Context } from '@hydra1902/cordis'
import type {} from '@hydra1902/harness-api-remotes/client'

/** The generated Remote namespaces a Session and its manager call. */
export type SessionRemotes = Pick<Context['remote'], 'commands'>
