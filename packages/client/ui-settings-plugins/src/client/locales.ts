/** Locale bundles for the plugin configuration section and its plugin cards. */

/** Locale keys these surfaces render. */
export type PluginsSettingsLocaleKey =
  | 'userMcpNameTaken' | 'userHooksNameTaken' | 'mcpLoadError' | 'mcpRetry'
  | 'nav' | 'title' | 'intro' | 'tabs' | 'search' | 'configurableTab' | 'mcpTab' | 'hooksTab' | 'empty'
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
  | 'userMcpTitle' | 'userMcpDescription' | 'userMcpAdd' | 'userMcpAddTitle' | 'userMcpEditTitle'
  | 'userMcpFormDescription' | 'userMcpEmpty' | 'userMcpEmptySearch' | 'userMcpLoadError' | 'userMcpRetry'
  | 'userMcpMutationError' | 'userMcpSaveError' | 'userMcpEdit' | 'userMcpRemove' | 'userMcpSave'
  | 'userMcpCancel' | 'userMcpClose' | 'userMcpName' | 'userMcpTransport' | 'userMcpTransportStdio'
  | 'userMcpTransportHttp' | 'userMcpCommand' | 'userMcpArgs' | 'userMcpCwd' | 'userMcpEnv'
  | 'userMcpEnvHint' | 'userMcpEnvInvalid' | 'userMcpEnvStored' | 'userMcpUrl' | 'userMcpHeaders'
  | 'userMcpHeadersHint' | 'userMcpHeadersInvalid' | 'userMcpHeadersStored' | 'userMcpTools'
  | 'userMcpStarted' | 'userMcpStarting' | 'userMcpFailed' | 'userMcpInvalid'
  | 'userHooksDescription' | 'userHooksTrust' | 'userHooksAdd' | 'userHooksAddTitle'
  | 'userHooksEditTitle' | 'userHooksFormDescription' | 'userHooksEmpty' | 'userHooksEmptySearch'
  | 'userHooksLoading' | 'userHooksLoadError' | 'userHooksRetry' | 'userHooksMutationError'
  | 'userHooksSaveError' | 'userHooksEdit' | 'userHooksRemove' | 'userHooksSave' | 'userHooksCancel'
  | 'userHooksClose' | 'userHooksName' | 'userHooksDialect' | 'userHooksDialectClaudeCode'
  | 'userHooksDialectCodex' | 'userHooksSource' | 'userHooksSourceInline' | 'userHooksSourceFile'
  | 'userHooksInlineSource' | 'userHooksPath' | 'userHooksConfig' | 'userHooksConfigHint'
  | 'userHooksConfigInvalid' | 'userHooksPluginRoot' | 'userHooksProjectDir' | 'userHooksEvents'
  | 'userHooksStarted' | 'userHooksFailed' | 'userHooksInvalid' | 'userHooksUnavailable'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  userMcpNameTaken: 'A server with this name already exists. Edit it or choose another name.',
  userHooksNameTaken: 'A hook record with this name already exists. Edit it or choose another name.',
  mcpLoadError: 'MCP servers could not be loaded.',
  mcpRetry: 'Retry',
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'Configure and inspect the plugins installed in this deployment.',
  tabs: 'Plugin views',
  search: 'Search plugins, skills, hooks, marketplaces, and MCP servers',
  configurableTab: 'Configuration',
  mcpTab: 'MCP',
  hooksTab: 'Hooks',
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
  userMcpTitle: 'Your MCP servers',
  userMcpDescription: 'Saved in your settings file, so they come back the next time you start.',
  userMcpAdd: 'Add server',
  userMcpAddTitle: 'Add MCP server',
  userMcpEditTitle: 'Edit MCP server',
  userMcpFormDescription: 'A new server is saved switched off. Turn it on when you are ready to run it.',
  userMcpEmpty: 'You have not added any MCP servers.',
  userMcpEmptySearch: 'No matching MCP servers.',
  userMcpLoadError: 'Your MCP servers are temporarily unavailable.',
  userMcpRetry: 'Retry',
  userMcpMutationError: 'The server could not be changed.',
  userMcpSaveError: 'The server was not saved. Check the fields and try again.',
  userMcpEdit: 'Edit',
  userMcpRemove: 'Remove',
  userMcpSave: 'Save server',
  userMcpCancel: 'Cancel',
  userMcpClose: 'Close',
  userMcpName: 'Name',
  userMcpTransport: 'Connection',
  userMcpTransportStdio: 'Local command (stdio)',
  userMcpTransportHttp: 'Remote endpoint (HTTP)',
  userMcpCommand: 'Command',
  userMcpArgs: 'Arguments, one per line',
  userMcpCwd: 'Working directory',
  userMcpEnv: 'Environment, one NAME=value per line',
  userMcpEnvHint: 'Values are never shown again. Leave blank to keep what is saved.',
  userMcpEnvInvalid: 'Each line needs a NAME=value pair.',
  userMcpEnvStored: 'Environment',
  userMcpUrl: 'Endpoint URL',
  userMcpHeaders: 'Headers, one Name=value per line',
  userMcpHeadersHint: 'Values are never shown again. Leave blank to keep what is saved.',
  userMcpHeadersInvalid: 'Each line needs a Name=value pair.',
  userMcpHeadersStored: 'Headers',
  userMcpTools: 'Tools',
  userMcpStarted: 'Connected',
  userMcpStarting: 'Connecting…',
  userMcpFailed: 'Could not connect',
  userMcpInvalid: 'Saved settings are incomplete',
  userHooksDescription: 'Saved in your settings file, so they come back the next time you start.',
  userHooksTrust: 'A hook runs commands on your machine. Only enable hooks you wrote or trust.',
  userHooksAdd: 'Add hooks',
  userHooksAddTitle: 'Add hooks',
  userHooksEditTitle: 'Edit hooks',
  userHooksFormDescription: 'A new hook record is saved switched off. Turn it on when you are ready to run it.',
  userHooksEmpty: 'You have not added any hooks.',
  userHooksEmptySearch: 'No matching hooks.',
  userHooksLoading: 'Reading hooks…',
  userHooksLoadError: 'Your hooks are temporarily unavailable.',
  userHooksRetry: 'Retry',
  userHooksMutationError: 'The hooks could not be changed.',
  userHooksSaveError: 'The hooks were not saved. Check the fields and try again.',
  userHooksEdit: 'Edit',
  userHooksRemove: 'Remove',
  userHooksSave: 'Save hooks',
  userHooksCancel: 'Cancel',
  userHooksClose: 'Close',
  userHooksName: 'Name',
  userHooksDialect: 'Format',
  userHooksDialectClaudeCode: 'Claude Code',
  userHooksDialectCodex: 'Codex',
  userHooksSource: 'Definitions',
  userHooksSourceInline: 'Written here',
  userHooksSourceFile: 'Read from a file',
  userHooksInlineSource: 'Written in your settings file',
  userHooksPath: 'File path',
  userHooksConfig: 'Hook definitions (JSON)',
  userHooksConfigHint: 'Paste an existing hooks.json, with or without its "hooks" wrapper.',
  userHooksConfigInvalid: 'Enter a JSON object of hook events.',
  userHooksPluginRoot: 'Plugin root (optional)',
  userHooksProjectDir: 'Project directory (optional)',
  userHooksEvents: 'Events',
  userHooksStarted: 'Active',
  userHooksFailed: 'Could not start',
  userHooksInvalid: 'Definitions could not be read',
  userHooksUnavailable: 'Hook management is available from the local desktop app only.',
}
