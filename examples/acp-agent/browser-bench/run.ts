/* oxlint-disable -- benchmark runner is an executable example resolved through tsx, outside package tsconfig paths. */
/** Offline browser corpus through the real tool runtime, browser service, and NDJSON child seam. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@hydraharness/cordis'
import AgentRegistry, { Inbox } from '@hydraharness/harness-agent'
import type { Agent } from '@hydraharness/harness-agent'
import BrowserSessionService from '@hydraharness/harness-browser-electron'
import type { BrowserOutcome } from '@hydraharness/harness-browser-electron'
import { CallId, createMessage, createToolResultMessage } from '@hydraharness/harness-llm'
import { Session, SessionId } from '@hydraharness/harness-session'
import SystemPrompt from '@hydraharness/harness-system-prompt'
import ToolRuntime from '@hydraharness/harness-tools'
import TokenMeter from '@hydraharness/harness-token-meter'
import ToolResultPruner from '@hydraharness/harness-compaction-tool-result-pruner'
import * as ToolBrowser from '@hydraharness/harness-tool-browser'
import { BenchmarkChild } from './child.mjs'
import login from './scenarios/login.mjs'
import table from './scenarios/table.mjs'
import spa from './scenarios/spa.mjs'
import dialog from './scenarios/dialog.mjs'
import poor from './scenarios/poor-accessibility.mjs'
import multi from './scenarios/multi-tab.mjs'

const root = resolve(import.meta.dirname, '../../..')
const revision = process.argv.find(arg => arg.startsWith('--revision='))?.slice(11)
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
const check = process.argv.includes('--check')
const work = revision === undefined ? undefined : await mkdtemp(resolve(root, '.git/browser-bench-'))
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]

try {
  let plugin = ToolBrowser
  if (work !== undefined && revision !== undefined) {
    for (const file of ['index.ts', 'render.ts', 'prompt.ts']) {
      const source = execFileSync('git', ['show', `${revision}:packages/browser/tool-browser/src/${file}`], { cwd: root })
      await writeFile(resolve(work, file), source)
    }
    plugin = await import(pathToFileURL(resolve(work, 'index.ts')).href) as typeof ToolBrowser
  }
  const report = { version: 1, source: revision ?? 'working-tree', tokenMethod: 'token-meter heuristic; not provider billing', scenarios: [] as unknown[] }
  for (const scenario of [login, table, spa, dialog, poor, multi]) {
    const ctx = new Context()
    const child = new BenchmarkChild(scenario)
    try {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(TokenMeter)
      await ctx.plugin(ToolResultPruner)
      await ctx.plugin(BrowserSessionService, { electronPath: '/scripted/electron', show: false,
        browserPermissions: { browsing: 'allow', downloads: 'allow', uploads: 'allow' },
      })
      ctx.browsers.spawnChild = () => child
      await ctx.plugin(plugin)
      const session = Session.create(SessionId(`bench-${scenario.name}`))
      const scope = ctx.plugin(() => {})
      const agent: Agent = {
        id: session.id, options: { provider: 'scripted', model: 'scripted' }, session, status: 'idle', ctx: scope.ctx,
        inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
        send() {}, followup() {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
        inject() {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      ctx.agents.register(agent)
      session.append('turn/start', { turn: 1 })
      const calls: Array<Record<string, unknown>> = []
      const visible = new Map<number, Set<number>>()
      const timings: number[] = []
      let staleIndexFailures = 0
      let outcome: BrowserOutcome | undefined
      const perform = ctx.browsers.perform.bind(ctx.browsers)
      ctx.browsers.perform = async (...args) => { outcome = await perform(...args); return outcome }
      const prefix = JSON.stringify({ system: await ctx.systemPrompt.assemble(), tools: ctx.tools.schemas() })
      for (const [offset, [name, args]] of scenario.calls.entries()) {
        const step = offset + 1
        const callId = CallId(`call-${step}`)
        session.append('step/start', { turn: 1, step })
        session.append('assistant/message', {
          turn: 1, step, message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'scripted', model: 'scripted' }, content: [{ type: 'tool-call', name, arguments: JSON.stringify(args), id: callId }] }),
        }, { surfaceOp: 'append' })
        session.append('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
        const started = performance.now()
        const result = await ctx.tools.execute({ name, arguments: args, callId, agent, signal: new AbortController().signal })
        timings.push(performance.now() - started)
        assert(!result.isError, JSON.stringify(result))
        const value = result.value as unknown as ToolBrowser.BrowserToolValue
        assert(outcome)
        const requested = args.fields?.map(field => field.index) ?? [args.index]
        if (outcome.action?.success === false
          && requested.some(index => index !== undefined && !visible.get(args.tab_id ?? value.tabId)?.has(index))) {
          staleIndexFailures++
        }
        const delivered = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
        const indices = [...delivered.matchAll(/\[(\d+)\]</gu)].map(match => Number(match[1]))
        // A diff updates the preceding list; full results replace it.
        if ('mode' in value && value.mode === 'diff') {
          const previous = visible.get(value.tabId) ?? new Set<number>()
          for (const line of (value as unknown as { removed: string[] }).removed) {
            const match = /\[(\d+)\]</u.exec(line)
            if (match) previous.delete(Number(match[1]))
          }
          for (const index of indices) previous.add(index)
          visible.set(value.tabId, previous)
        } else if (!('unchanged' in value && value.unchanged)) visible.set(value.tabId, new Set(indices))
        const message = createToolResultMessage({ callId, content: result.content, isError: result.isError })
        session.append('tool/result', { turn: 1, step, message, ...result.meta === undefined ? {} : { meta: result.meta } }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step })
        calls.push({ tool: name, tabId: value.tabId, rawChars: outcome.state.header.length + outcome.state.content.length + outcome.state.footer.length, deliveredChars: delivered.length, tokens: ctx.tokenMeter.estimateMessage(message), compact: value.compact, truncated: value.truncated, unchanged: 'unchanged' in value ? value.unchanged : value.mode === 'diff' && value.baseRevision === value.revision, isError: result.isError })
        assert.equal(JSON.stringify({ system: await ctx.systemPrompt.assemble(), tools: ctx.tools.schemas() }), prefix, `${scenario.name}: prefix changed`)
      }
      const tokensBeforePruning = ctx.tokenMeter.measure(session).totalTokens
      if (revision === undefined) ctx.toolResultPruner.pruneSession(session)
      const tokensAfterPruning = ctx.tokenMeter.measure(session).totalTokens
      assert.deepEqual(session.deriveMessages(), session.deriveMessages())
      const chars = calls.map(call => call.deliveredChars as number)
      const tokens = calls.map(call => call.tokens as number)
      report.scenarios.push({ name: scenario.name, calls, p50Chars: percentile(chars, .5), p95Chars: percentile(chars, .95), p50Tokens: percentile(tokens, .5), p95Tokens: percentile(tokens, .95), totalBrowserTokens: tokens.reduce((a, b) => a + b, 0), roundTrips: calls.length, stateRereads: calls.filter(call => call.tool === 'browser_state').length - 1, staleIndexFailures, taskSuccess: child.actionFailures === 0, tokensBeforePruning, tokensAfterPruning })
      process.stderr.write(`${scenario.name}: p50/p95 chars ${percentile(chars, .5)}/${percentile(chars, .95)}, tokens ${percentile(tokens, .5)}/${percentile(tokens, .95)}; action wall ms ${JSON.stringify(timings.map(ms => Number(ms.toFixed(3))))}\n`)
    } finally { child.kill() }
  }
  const bytes = `${JSON.stringify(report, undefined, 2)}\n`
  if (output === undefined) process.stdout.write(bytes)
  else if (check) assert.equal(await readFile(resolve(root, output), 'utf8'), bytes)
  else await writeFile(resolve(root, output), bytes)
} finally {
  if (work !== undefined) await rm(work, { recursive: true, force: true })
}
