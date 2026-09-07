/** Citation evidence is derived from successful, preceding fetch results in the loaded transcript. */
import type { ConversationNode, ToolCallBlock } from '@hydra/harness-client-runtime/client'
import type { MarkdownCitations } from '@hydra/harness-client-ui-primitives'

/**
 * Index source versions without a separate evidence database, including Code Mode subcalls.
 * @param nodes - loaded session transcript; missing historical sources remain unresolved.
 * @param beforeSeq - assistant message position, excluding sources retrieved later.
 * @returns resolver accepting only exact nonempty quotes from successful recorded fetches.
 */
export function webCitations(nodes: readonly ConversationNode[], beforeSeq: number): MarkdownCitations {
  const sources = new Map<string, { url: string; text: string }>()
  function visit(call: ToolCallBlock): void {
    for (const child of call.subCalls) visit(child)
    if (!('kind' in call) || call.isError || call.seq >= beforeSeq
      || call.call?.name !== 'web_fetch') return
    const block = call.content[0]
    if (block?.type !== 'text') return
    const match = /^Fetched (https?:\/\/\S+) \(HTTP 2\d\d\)\nSource: ([a-f0-9]{64})\n\n([\s\S]*)$/.exec(block.text)
    if (match === null) return
    const url = match[1] as string
    const id = match[2] as string
    const body = match[3] as string
    const text = body.replace(/\n\n\(Content truncated\. Fetch a more specific URL or section for the full text\.\)$/, '')
    sources.set(id, { url, text })
  }
  for (const node of nodes) if (node.kind === 'tool-result') visit(node)
  return {
    resolve(id, quote) {
      if (quote.trim() === '') return undefined
      const source = sources.get(id)
      if (source === undefined) return undefined
      const start = source.text.indexOf(quote)
      if (start < 0) return undefined
      return { url: source.url, start, end: start + quote.length }
    },
  }
}
