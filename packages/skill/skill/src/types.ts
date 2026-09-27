/**
 * Client-safe skill registry event vocabulary shared with type-only consumers.
 * @module @hydra1902/harness-skill/types
 */

import type {} from '@hydra1902/cordis'

declare module '@hydra1902/cordis' {
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
