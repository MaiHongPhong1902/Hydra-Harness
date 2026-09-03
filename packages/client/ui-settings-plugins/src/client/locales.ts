/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'search' | 'configurableTab' | 'mcpTab' | 'empty'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidNumber'
  | 'bashTitle' | 'bashDescription' | 'bashTimeoutMs' | 'bashTimeoutMsHint'
  | 'bashMaxOutputBytes' | 'bashMaxOutputBytesHint'
  | 'agentLoopTitle' | 'agentLoopDescription' | 'agentLoopMaxParallel' | 'agentLoopMaxParallelHint'
  | 'webSearchTitle' | 'webSearchDescription'
  | 'webSearchApiKey' | 'webSearchApiKeyHint' | 'webSearchApiKeySet' | 'webSearchApiKeyUnset'
  | 'webSearchBaseUrl' | 'webSearchBaseUrlHint' | 'webSearchMaxUses' | 'webSearchMaxUsesHint'
  | 'mcpTitle' | 'mcpDescription' | 'mcpUnavailable'
  | 'mcpLoading' | 'mcpEnabled' | 'mcpToggleFailed' | 'importedMcpTitle' | 'importedMcpEmpty' | 'enable' | 'disable' | 'disabled'
  | 'mcpApiKey' | 'mcpApiKeyHint' | 'mcpApiKeySet' | 'mcpApiKeyUnset'
  | 'mcpTargetDomain' | 'mcpTargetDomainHint' | 'mcpInvalidDomain'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  search: 'Search plugins, skills, hooks, marketplaces, and MCP servers',
  configurableTab: 'Configuration',
  mcpTab: 'MCP',
  empty: 'This deployment exposes no plugin settings.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  bashTitle: 'Shell',
  bashDescription: 'Limits every command the agent runs.',
  bashTimeoutMs: 'Command timeout (ms)',
  bashTimeoutMsHint: 'How long one command may run before it is terminated.',
  bashMaxOutputBytes: 'Output cap per stream (bytes)',
  bashMaxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  agentLoopTitle: 'Agent loop',
  agentLoopDescription: 'How the agent dispatches tool calls.',
  agentLoopMaxParallel: 'Parallel tool calls',
  agentLoopMaxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  webSearchTitle: 'Web search',
  webSearchDescription: 'DeepSeek search provider.',
  webSearchApiKey: 'API key',
  webSearchApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  webSearchApiKeySet: 'A key is configured.',
  webSearchApiKeyUnset: 'No key is configured; search is unavailable until one is.',
  webSearchBaseUrl: 'Endpoint',
  webSearchBaseUrlHint: 'Leave blank to use the provider default.',
  webSearchMaxUses: 'Max searches per request',
  webSearchMaxUsesHint: 'How many times one request may search before it must answer.',
  mcpTitle: 'Obsidian MCP',
  mcpDescription: 'Knowledge access through the local Obsidian MCP server at 127.0.0.1:27123.',
  mcpUnavailable: 'The Obsidian MCP plugin is disabled or unavailable.',
  mcpLoading: 'Reading MCP servers…',
  mcpEnabled: 'Enabled',
  mcpToggleFailed: 'The MCP plugin state could not be changed.',
  importedMcpTitle: 'Imported OpenAI/Codex MCP servers',
  importedMcpEmpty: 'No imported plugins provide MCP servers.',
  enable: 'Enable',
  disable: 'Disable',
  disabled: 'Disabled',
  mcpApiKey: 'API key',
  mcpApiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  mcpApiKeySet: 'A key is configured.',
  mcpApiKeyUnset: 'No key is configured; Obsidian MCP is unavailable until one is.',
  mcpTargetDomain: 'Browser target domain',
  mcpTargetDomainHint: 'Optional hostname for same-domain Browser evidence. Leave blank for knowledge-only use.',
  mcpInvalidDomain: 'Enter one hostname without a scheme, port, path, or wildcard.',
}
