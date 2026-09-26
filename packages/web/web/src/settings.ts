/** Product search selection and invocation limits, independent of chat configuration. */

import z from '@hydra1902/schemastery'

/** Saved search preferences. Empty provider requires an explicit user selection. */
export interface WebSearchSettings {
  enabled: boolean
  provider: string
  maxQueries: number
  maxResults: number
  timeoutMs: number
}

/** Schema shared by registration and composition default resolution. */
export const SearchSettings: z<Partial<WebSearchSettings>, WebSearchSettings> = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default(''),
  maxQueries: z.number().step(1).min(1).max(100).default(4),
  maxResults: z.number().step(1).min(1).max(100).default(8),
  timeoutMs: z.number().step(1).min(1).max(600000).default(60000),
})
