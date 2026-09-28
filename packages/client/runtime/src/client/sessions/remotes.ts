/**
 * Remote namespaces the Session cluster calls. One parameter for one concept:
 * the generated surface a Session and its manager reach the Host through.
 *
 * @module @hydraharness/harness-client-runtime/client/sessions/remotes
 */

import type { Context } from '@hydraharness/cordis'
import type {} from '@hydraharness/harness-api-remotes/client'

/** The generated Remote namespaces a Session and its manager call. */
export type SessionRemotes = Pick<Context['remote'], 'commands'>
