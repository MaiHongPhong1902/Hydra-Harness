/** Local research measurements from canonical JSONL logs; never uploads transcript content. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

interface ToolMeasurement { name: string; durationMs: number | null; error: boolean; outputChars: number }

/**
 * Measure recorded native and Code Mode calls without counting fork seeds twice.
 * @param jsonl - one session JSONL file.
 * @returns tool timings and provider-reported tokens; absent timing remains null.
 */
export function researchReport(jsonl: string): {
  tools: ToolMeasurement[]
  modelRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
} {
  const rows: unknown[] = jsonl.split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
  const starts = new Map<string, { name: string; time: number | null }>()
  const tools: ToolMeasurement[] = []
  let seedLength = 0
  let eventIndex = 0
  let modelRequests = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  for (const row of rows) {
    const event = object(row)
    if (event === undefined || typeof event.type !== 'string') throw new Error('session log row must be an object with a type')
    if (event.type === 'session') { seedLength = count(event.seedLength); continue }
    const data = object(event.data)
    if (data === undefined) throw new Error('session event must carry an object data field')
    const packed = event.type === 'text-chunks' || event.type === 'reasoning-chunks' ? data.texts
      : event.type === 'tool-call-chunks' ? data.args : undefined
    const inherited = eventIndex < seedLength
    eventIndex += Array.isArray(packed) ? packed.length : 1
    if (inherited) continue
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null
    if (event.type === 'step/start') modelRequests++
    if (event.type === 'assistant/message') {
      const usage = object(data.usage)
      inputTokens += count(usage?.inputTokens)
      outputTokens += count(usage?.outputTokens)
      cacheReadTokens += count(usage?.cacheReadTokens)
    }
    if (event.type === 'tool/call' || event.type === 'tool/code-dispatch-start') {
      const id = data.callId ?? data.subCallId
      if (typeof id === 'string' && typeof data.name === 'string') starts.set(id, { name: data.name, time })
    }
    if (event.type !== 'tool/result' && event.type !== 'tool/code-dispatch') continue
    const message = object(data.message)
    const source = object(message?.source)
    const id = source?.callId ?? data.subCallId
    if (typeof id !== 'string') continue
    const start = starts.get(id)
    const envelope = Array.isArray(message?.content) ? object(message.content[0]) : undefined
    const content = envelope?.content ?? data.content
    tools.push({
      name: start?.name ?? (typeof data.name === 'string' ? data.name : 'unknown'),
      durationMs: time !== null && start?.time !== null && start?.time !== undefined ? Math.max(0, time - start.time) : null,
      error: envelope?.isError === true || data.isError === true,
      outputChars: Array.isArray(content) ? content.reduce((total: number, block: unknown) => {
        const value = object(block)?.text
        return total + (typeof value === 'string' ? value.length : 0)
      }, 0) : 0,
    })
    starts.delete(id)
  }
  return { tools, modelRequests, inputTokens, outputTokens, cacheReadTokens }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2)
  if (paths.length === 0) throw new Error('Usage: pnpm research:report <session.jsonl> [child-session.jsonl ...]')
  const reports = await Promise.all(paths.map(async path => ({ path, ...researchReport(await readFile(path, 'utf8')) })))
  process.stdout.write(JSON.stringify(reports, null, 2) + '\n')
}
