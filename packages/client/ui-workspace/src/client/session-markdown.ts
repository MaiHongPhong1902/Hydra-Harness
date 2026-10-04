/** Complete committed transcript export, independent of the selected history window. */
import type { IApiClient, SessionId } from '@hydraharness/harness-client-connection/client'
import { isAppendSurfaceEvent } from '@hydraharness/harness-client-runtime/client'

/**
 * Read every history page, retaining append-origin user text and assistant text.
 * Tool payloads, reasoning, injected context and model-only replacements are omitted.
 * @param api - the connected Host client.
 * @param sessionId - session to read without selecting or resuming it.
 * @param title - display title for the Markdown heading.
 * @returns the complete committed text transcript; rejects on any failed page.
 */
export async function sessionMarkdown(api: IApiClient, sessionId: SessionId, title: string): Promise<string> {
  const pages: string[][] = []
  let beforeSeq: number | undefined
  while (true) {
    const { result } = await api.sessions.history({ sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
    if (!result.ok) throw new Error(result.error.message)
    const messages: string[] = []
    for (const { event } of result.value.events) {
      if (!isAppendSurfaceEvent(event)) continue
      const content = event.type === 'user/message' && event.data.source.kind === 'user'
        ? event.data.content
        : event.type === 'assistant/message' ? event.data.message.content : undefined
      if (content === undefined) continue
      const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text !== '') messages.push(`## ${event.type === 'user/message' ? 'User' : 'Assistant'}\n\n${text}`)
    }
    pages.unshift(messages)
    if (!result.value.hasMore) break
    const next = result.value.events[0]?.event.seq
    if (next === undefined || (beforeSeq !== undefined && next >= beforeSeq)) {
      throw new Error('History pagination did not advance')
    }
    beforeSeq = next
  }
  return [`# ${title.replaceAll('\n', ' ')}`, ...pages.flat()].join('\n\n')
}
