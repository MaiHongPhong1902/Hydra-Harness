/**
 * Classifies Markdown fences that contain runnable commands or terminal output.
 */
export type CodeBlockKind = 'command' | 'output'

const commandLanguages = new Set(['sh', 'shell', 'shellscript', 'bash', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'bat', 'batch'])
const outputLanguages = new Set(['output', 'console', 'terminal-output', 'stdout', 'stderr'])

/**
 * Returns the presentation kind for a fence info string.
 *
 * @param info - Markdown fence info, including its language and optional flags.
 * @returns The command/output kind, or `undefined` for source snippets and other fences.
 */
export function codeBlockKind(info: string): CodeBlockKind | undefined {
  const words = info.trim().split(/\s+/).filter(Boolean)
  const language = words[0]?.toLowerCase() ?? ''
  if (commandLanguages.has(language)) return 'command'
  if (outputLanguages.has(language) || words.includes('output')) return 'output'
  return undefined
}

/**
 * Removes shell prompts from command content before it is highlighted and copied.
 *
 * @param content - Raw Markdown fence content.
 * @returns Command text without prompt prefixes.
 */
export function normalizeCommand(content: string): string {
  return content
    .replace(/^[ \t]*PS(?: [^>\r\n]*)?>[ \t]?/gmu, '')
    .replace(/^[ \t]*(?:[$>])[ \t]?/gmu, '')
}

/**
 * Adds command/output classes and command-specific copy semantics to rendered HTML.
 *
 * @param html - HTML returned by the VitePress fence renderer.
 * @param kind - Presentation kind for the fence.
 * @returns Decorated fence HTML.
 */
export function decorateFenceHtml(html: string, kind: CodeBlockKind): string {
  const openingTag = html.match(/<div class="([^"]*language-[^"]*)"/)
  if (openingTag === null) throw new Error('VitePress code-fence output has no language container.')
  const className = kind === 'command' ? 'hydra-command-block' : 'hydra-output-block'
  const decorated = html.replace(openingTag[0], `<div class="${openingTag[1]} ${className}"`)
  const copyButton = /<button\b(?=[^>]*\bclass="[^"]*\bcopy\b)[^>]*><\/button>/
  if (kind === 'output') return decorated.replace(copyButton, '')
  return decorated.replace(copyButton, '<button title="Copy command" aria-label="Copy command to clipboard" class="copy"></button>')
}
