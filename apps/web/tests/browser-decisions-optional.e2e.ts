// Assembled Web coverage for browser-decisions without the optional Jev row.
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@hydra/harness-llm'
import { SessionId } from '@hydra/harness-session'
import type { PluginInventoryGateway } from '@hydra/harness-host-plugin-inventory'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const OVERLAY = fileURLToPath(new URL('./browser-decisions.overlay.yml', import.meta.url))

describe('web e2e: browser decisions without Jev', () => {
  let scaffold: WebScaffold

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  }, 120_000)

  afterAll(async () => {
    await scaffold?.close()
  })

  it('keeps the advisory tool callable and abstains when Jev is absent', async () => {
    const tool = scaffold.ctx.tools.get('browser_decide')
    expect(tool).toBeDefined()
    expect(tool?.description).toContain('only returns advice')
    const result = await tool!.execute({
      state: 'button is visible', question: 'what next?', choices: ['click', 'stop'],
    }, { callId: 'browser-decisions-e2e', signal: new AbortController().signal } as never)
    expect(result).toEqual({ available: false, reason: 'Jev provider is disabled or unavailable.' })
  })

  it('finishes an agent turn after an unavailable decision', async () => {
    class DecisionAdapter extends LlmAdapter {
      requests: GenerateOptions[] = []
      override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        this.requests.push(request)
        if (this.requests.length === 1) {
          yield { type: 'tool-call-delta', index: 0, id: CallId('optional-jev'), name: 'browser_decide',
            argumentsDelta: JSON.stringify({ state: 'Continue button visible', question: 'Next?', choices: ['continue', 'stop'] }) }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          yield { type: 'text-delta', index: 0, text: 'Agent continues without Jev.' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    const adapter = new DecisionAdapter()
    scaffold.ctx.llm.registerAdapter(['jev-fallback-test'], adapter)
    const handle = await scaffold.ctx.agents.create({ sessionId: SessionId('jev-fallback-turn'),
      meta: { cwd: scaffold.workspaceCwd }, agentOptions: { provider: 'jev-fallback-test', model: 'fixture' },
      setup: ctx => scaffold.ctx.agentPresets.mount(ctx).then(() => undefined),
    })
    try {
      const run = async (): Promise<void> => {
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the task.' }] }))
        await handle.agent.whenIdle()
        await scaffold.ctx.sessions.flush(handle.agent.session)
        const end = handle.agent.session.events.findLast(event => event.type === 'turn/end')
        expect(end?.data.reason).toEqual({ kind: 'completed' })
      }
      await run()
      expect(adapter.requests).toHaveLength(2)
      expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Jev provider is disabled or unavailable')
      expect(handle.agent.session.events.some(event => event.type === 'tool/result')).toBe(true)
    } finally { await handle.dispose() }
  })

  it('saves Jev, its UI, and its bounded consumer together for restart', async () => {
    const inventory = scaffold.ctx.get('pluginInventory') as PluginInventoryGateway
    const entry = (await inventory.list()).entries.find(row => row.moduleName === '@hydra/harness-jev')!
    expect(entry).toMatchObject({ enabled: false, toggleable: true })
    expect(entry.relatedModules).toEqual(expect.arrayContaining([
      '@hydra/harness-browser-decisions', '@hydra/harness-client-ui-jev',
    ]))
    const result = await inventory.setEnabled({ entryId: entry.entryId, enabled: true })
    expect(result.restartRequired).toBe(true)
    expect(scaffold.ctx.get('jev')).toBeUndefined()
    expect(result.snapshot.entries.find(row => row.entryId === entry.entryId)).toMatchObject({ pendingEnabled: true })
    const manifest: unknown = JSON.parse(await readFile(join(scaffold.harnessHome, 'profiles/scaffold/package.json'), 'utf8'))
    expect(manifest).toMatchObject({ hydra: { profile: { pluginEnablement: {
      jev: true, 'ui-jev': true, 'browser-decisions': true,
    } } } })
    const jevEntry = result.snapshot.entries.find(row => row.moduleName === '@hydra/harness-jev')
    expect(jevEntry).toMatchObject({ enabled: false, pendingEnabled: true, restartRequired: true })
    expect(jevEntry?.relatedModules).toContain('@hydra/harness-browser-decisions')
  })
})
