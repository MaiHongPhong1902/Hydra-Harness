/** Public types for the shared imported-plugin runtime. */

declare const importedPluginIdentityBrand: unique symbol

/** Source-qualified identity: `<plugin-name>@<source-id>`. */
export type ImportedPluginIdentity = string & { readonly [importedPluginIdentityBrand]: true }

/** Source descriptor retained for stable upgrades and source-owned paths. */
export interface ImportedPluginSource {
  readonly kind: 'local' | 'git' | 'marketplace-local' | 'marketplace-git'
  readonly source: string
  readonly sourceId: string
  readonly ref?: string
  readonly path?: string
  readonly marketplace?: string
}

/** Optional structured form of an import source. A string is the common direct-import form. */
export interface ImportPluginRequest {
  /** Local plugin/marketplace folder or a Git repository source. */
  readonly source: string
  /** Marketplace plugin name when the source is a marketplace with multiple entries. */
  readonly plugin?: string
  /** Optional Git ref for a direct Git source. */
  readonly ref?: string
  /** Optional plugin subdirectory for a direct Git source. */
  readonly path?: string
}

/** A direct source string or the structured marketplace/Git form. */
export type PluginImportSource = string | ImportPluginRequest

/** Persisted/imported bundle lifecycle state. */
export type ImportedPluginLifecycle = 'installed' | 'disabled' | 'enabled' | 'loaded'

/** Current review state for discovered hooks, independent of plugin enablement. */
export type HookTrustState = 'not-applicable' | 'pending' | 'trusted'

/** OpenAI skill/plugin presentation and invocation metadata from `agents/openai.yaml`. */
export interface ImportedPluginAgentMetadata {
  readonly displayName?: string
  readonly shortDescription?: string
  readonly iconSmall?: string
  readonly iconLarge?: string
  readonly brandColor?: string
  readonly defaultPrompt?: string
  readonly allowImplicitInvocation?: boolean
}

/** Per-server state projected even before an MCP process is mounted. */
export interface ImportedMcpServerSnapshot {
  readonly name: string
  readonly enabled: boolean
  readonly startupState: 'not-started' | 'starting' | 'started' | 'failed'
  /** Local stdio servers need no connection authentication; remote state is host-observed. */
  readonly authenticationState: 'not-applicable' | 'unknown'
  readonly defaultToolsApprovalMode: 'ask' | 'allow' | 'deny'
  readonly toolApproval: Readonly<Record<string, 'ask' | 'allow' | 'deny'>>
  /** Currently registered, host-qualified MCP tool names. */
  readonly tools: readonly string[]
}

/** One installed bundle's browser/command-facing state. */
export interface ImportedPluginEntry {
  readonly identity: ImportedPluginIdentity
  readonly name: string
  readonly version: string
  readonly source: ImportedPluginSource
  readonly pluginRoot: string
  readonly dataPath: string
  readonly enabled: boolean
  /** Enablement at runtime startup; bundles installed afterwards start disabled. */
  readonly initialEnabled?: boolean
  readonly lifecycle: ImportedPluginLifecycle
  readonly hookTrustState: HookTrustState
  readonly hookDefinitionDigest?: string
  readonly skills: readonly string[]
  readonly mcpServers: readonly ImportedMcpServerSnapshot[]
  readonly hooks: readonly string[]
  /** OpenAI presentation metadata; it does not execute plugin code. */
  readonly agentMetadata?: ImportedPluginAgentMetadata
  /** Registered app/MCP mapping names from inert `.app.json` metadata. */
  readonly appMappings?: readonly string[]
  readonly installationStatus: 'installed'
}

/** Complete immutable snapshot returned by every public operation. */
export interface ImportedPluginSnapshot {
  readonly plugins: readonly ImportedPluginEntry[]
}

/** Manifest metadata that the importer understands without executing bundle code. */
export interface PluginManifest {
  /** Manifest format selected by the runtime. */
  readonly format?: 'legacy' | 'portable' | 'claude'
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly author?: string | Readonly<Record<string, unknown>>
  readonly homepage?: string
  readonly repository?: string
  readonly license?: string
  readonly keywords?: readonly string[]
  readonly skills?: string | readonly string[]
  readonly mcpServers?: string | readonly string[] | Readonly<Record<string, unknown>>
  readonly apps?: string | readonly string[] | Readonly<Record<string, unknown>>
  readonly hooks?: string | readonly string[] | Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[]
  readonly interface?: Readonly<Record<string, unknown>>
}
