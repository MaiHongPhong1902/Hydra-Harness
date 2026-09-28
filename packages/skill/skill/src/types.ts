/**
 * Client-safe skill registry event vocabulary shared with type-only consumers.
 * @module @hydraharness/harness-skill/types
 */

import type {} from '@hydraharness/cordis'

declare module '@hydraharness/cordis' {
  interface Events {
    /**
     * A skill provider, runtime contribution, or provider-backed catalog may
     * have changed. This is an unfiltered invalidation notification; consumers
     * refetch the catalog for their own lookup options. Listener failures are
     * contained and cannot veto the registry mutation.
     * @mode emit
     */
    'skills/change'(): void
  }
}
