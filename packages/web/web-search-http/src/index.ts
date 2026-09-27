/** Serper and configurable JSON search providers registered on the existing web service. */

import type { Context } from '@hydra1902/cordis'
import z from '@hydra1902/schemastery'
import { credentialRef } from '@hydra1902/harness-credentials'
import { launchEnvironmentOf } from '@hydra1902/harness-launch-environment'
import { installSettingsSection, settingsNamespace } from '@hydra1902/harness-settings'
import { WEB_SEARCH_CAPABILITIES } from '@hydra1902/harness-web'
import type { SearchConfigField, WebSearchProviderDescriptor } from '@hydra1902/harness-web'
import { HttpSearchProvider, validateSearchConfig } from './provider.ts'
import type { HttpSearchConfig } from './provider.ts'

export { HttpSearchProvider, validateSearchConfig } from './provider.ts'
export type { HttpSearchConfig } from './provider.ts'

/** Cordis plugin name. */
export const name = 'web-search-http'
/** Search registry required by both provider registrations. */
export const inject = ['web']

const fields: SearchConfigField[] = [
  { key: 'displayName', label: 'Provider Name', kind: 'text' },
  { key: 'endpoint', label: 'Endpoint', kind: 'text' },
  { key: 'method', label: 'HTTP Method', kind: 'select', options: ['POST', 'GET'] },
  { key: 'auth', label: 'Authentication', kind: 'select', options: ['none', 'bearer', 'api_key_header', 'custom_header'] },
  { key: 'authHeader', label: 'API Key / Custom Header Name', kind: 'text' },
  { key: 'queryField', label: 'Query Field', kind: 'text' },
  { key: 'limitField', label: 'Limit Field', kind: 'text' },
  { key: 'resultsPath', label: 'Results Path', kind: 'text' },
  { key: 'titleField', label: 'Title Field', kind: 'text' },
  { key: 'urlField', label: 'URL Field', kind: 'text' },
  { key: 'snippetField', label: 'Snippet Field', kind: 'text' },
  { key: 'maxResults', label: 'Provider Result Limit', kind: 'number' },
  { key: 'timeoutMs', label: 'Provider Timeout (ms)', kind: 'number', advanced: true },
  { key: 'maxResponseBytes', label: 'Maximum Response Bytes', kind: 'number', advanced: true },
  { key: 'headerRefs', label: 'Custom Headers', kind: 'json', advanced: true, hint: 'JSON mapping header names to credential references; store values through Credentials.' },
  { key: 'staticBody', label: 'Static Request JSON', kind: 'json', advanced: true, hint: 'Non-secret request fields only.' },
  ...[
    ['countryField', 'Country Field'], ['languageField', 'Language Field'], ['typeField', 'Search Type Field'],
    ['dateField', 'Date Field'], ['publishedAtField', 'Published Date Mapping'], ['scoreField', 'Score Mapping'],
    ['apiKeyEnv', 'Credential Reference'],
  ].map(([key, label]) => ({ key: key as string, label: label as string, kind: 'text' as const, advanced: true })),
]

/** Custom provider settings contain credential references and non-secret mapping values. */
export const CustomConfig: z<Partial<HttpSearchConfig>, HttpSearchConfig> = z.object({
  displayName: z.string().default('My Search Provider'),
  endpoint: z.string().default(''),
  method: z.union(['POST', 'GET']).default('POST'),
  auth: z.union(['none', 'bearer', 'api_key_header', 'custom_header']).default('api_key_header'),
  authHeader: z.string().default('X-API-KEY'),
  apiKeyEnv: z.string().role('credential-ref').default('CUSTOM_SEARCH_API_KEY'),
  queryField: z.string().default('q'),
  limitField: z.string().default('num'),
  resultsPath: z.string().default('results'),
  titleField: z.string().default('title'),
  urlField: z.string().default('url'),
  snippetField: z.string().default('snippet'),
  publishedAtField: z.string().default(''),
  scoreField: z.string().default(''),
  positionField: z.string().default(''),
  countryField: z.string().default(''),
  languageField: z.string().default(''),
  typeField: z.string().default(''),
  dateField: z.string().default(''),
  headerRefs: z.string().default('{}'),
  staticBody: z.string().default('{}'),
  timeoutMs: z.number().step(1).min(1).max(600000).default(60000),
  maxResponseBytes: z.number().step(1).min(1).default(5_000_000),
  maxResults: z.number().step(1).min(1).max(100).default(8),
})

/** Operator bases for the independent saved provider sections. */
export interface Config {
  /** Serper credential reference and request limits. */
  serper?: Pick<Partial<HttpSearchConfig>, 'apiKeyEnv' | 'maxResults' | 'timeoutMs' | 'maxResponseBytes'>
  /** Other provider endpoint, authentication, and JSON mappings. */
  custom?: Partial<HttpSearchConfig>
}

/** Both provider configurations are validated before registration. */
export const Config: z<Config> = z.object({
  serper: z.object({
    apiKeyEnv: z.string().role('credential-ref').default('SERPER_API_KEY'),
    maxResults: z.number().step(1).min(1).max(100).default(8),
    timeoutMs: z.number().step(1).min(1).max(600000).default(60000),
    maxResponseBytes: z.number().step(1).min(1).default(5_000_000),
  }),
  custom: CustomConfig,
})

/**
 * Mount both HTTP adapters, with independently hot-reloaded settings and credentials.
 * @param ctx - search, settings, and credential services.
 * @param config - optional deployment overrides.
 */
export function apply(ctx: Context, config: Config): void {
  const serper = CustomConfig({
    ...config.serper,
    endpoint: 'https://google.serper.dev/search', method: 'POST', auth: 'api_key_header', authHeader: 'X-API-KEY',
    apiKeyEnv: config.serper?.apiKeyEnv ?? 'SERPER_API_KEY',
    resultsPath: 'organic', titleField: 'title', urlField: 'link', snippetField: 'snippet', positionField: 'position',
    queryField: 'q', limitField: 'num', countryField: 'gl', languageField: 'hl',
  })
  register(ctx, 'serper', 'Serper.dev', serper, fields.filter(field =>
    ['maxResults', 'apiKeyEnv', 'timeoutMs', 'maxResponseBytes'].includes(field.key)))
  register(ctx, 'custom', 'Other', CustomConfig(config.custom ?? {}), fields)
}

/** Register one adapter and its saved configuration without retaining resolved keys. */
function register(ctx: Context, id: string, displayName: string, base: HttpSearchConfig, controls: SearchConfigField[]): void {
  validateSearchConfig(base)
  let current = () => base
  const descriptor: WebSearchProviderDescriptor = {
    id, displayName, configurable: true, capabilities: WEB_SEARCH_CAPABILITIES,
    settingsNs: `web-search-${id}`, credentialRef: base.apiKeyEnv, fields: controls,
  }
  installSettingsSection(ctx, settingsNamespace(descriptor.settingsNs), CustomConfig, base, {
    setSource: (source) => { current = source }, onChange: () => {}, validate: validateSearchConfig,
  })
  ctx.web.registerSearchProvider(new HttpSearchProvider(descriptor, () => current(), async (ref) => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(credentialRef(ref)))?.value
    return launchEnvironmentOf(ctx).get(ref)?.value
  }))
}
