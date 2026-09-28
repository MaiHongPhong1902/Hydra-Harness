import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@hydraharness/harness-app-boot'
import { CallId, createUserMessage, LlmAdapter, type GenerateOptions, type Message, type StreamChunk } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import type {} from '@hydraharness/harness-plugin-runtime'
import type {} from '@hydraharness/harness-tools'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('imported-skills snapshot requires an overlay path')
const rootConfig = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatch = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot('imported-skills-snapshot', rootConfig, [
  ...loadOverlayPatches('imported-skills-snapshot', basePatch),
  ...loadOverlayPatches('imported-skills-snapshot', overlayPath),
])
const requests: GenerateOptions[] = []
const adapter = new class extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}()
try {
  const identity = (await ctx.importedPlugins.import(join(process.cwd(), 'plugin'))).plugins[0]!.identity
  const installed = (await ctx.importedPlugins.enable(identity)).plugins[0]!
  function normalize(text: string): string {
    for (const name of installed.skills) {
      text = text.replaceAll(join(installed.pluginRoot, 'skills', name), `{{skills}}/${name}`)
    }
    return text
  }
  function project(messages: readonly Message[]) {
    return messages.filter(message => message.source.kind === 'user' || message.source.kind === 'skill-invocation')
      .map(message => ({ source: message.source, text: normalize(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) }))
  }
  async function tool(name: string, args: object) {
    const result = await ctx.tools.execute({ name, arguments: args, callId: CallId(name), signal: new AbortController().signal })
    return { isError: result.isError, text: normalize(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) }
  }
  const search = await tool('skill_search', { query: 'zebra reconciliation' })
  const denied = await tool('skill', { name: 'user-only' })
  const loaded = await tool('skill', { name: 'obsidian-uat-test-design' })
  ctx.llm.registerAdapter(['skill-fixture'], adapter)
  const turns = []
  for (const [index, task] of [
    'test obsidian',
    'Do not use obsidian-uat-test-design; explain what it does.',
    'Đừng dùng obsidian-uat-test-design.',
    '/user-only',
    '/model-only',
  ].entries()) {
    const handle = await ctx.agents.create({
      sessionId: SessionId(`skill-fixture-${index}`), meta: { cwd: process.cwd() },
      agentOptions: { provider: 'skill-fixture', model: 'fixture' },
    })
    try {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      const request = requests.at(-1)
      if (requests.length !== index + 1 || request === undefined) throw new Error('fixture requires one model request per turn')
      const logged = handle.agent.session.events.flatMap(event => event.type === 'user/message' ? [event.data] : [])
      turns.push({ request: project(request.messages), logged: project(logged) })
    } finally {
      await handle.dispose()
    }
  }
  await ctx.importedPlugins.disable(identity)
  const disabled = await tool('skill_search', { query: 'zebra reconciliation' })
  process.stdout.write(`${JSON.stringify({ search, denied, loaded, turns, disabled })}\n`)
} finally {
  await ctx.fiber.dispose()
}
