import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@hydraharness/harness-app-boot'
import { createApiProxy, RpcId } from '@hydraharness/harness-host-apiproxy'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@hydraharness/harness-llm'
import { SessionId } from '@hydraharness/harness-session'
import { settingsNamespace } from '@hydraharness/harness-settings'

const root = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const base = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const overlay = process.argv[2]
if (overlay === undefined) throw new Error('personalization snapshot requires an overlay')
const ctx = await boot('personalization-snapshot', root, [
  ...loadOverlayPatches('personalization-snapshot', base),
  ...loadOverlayPatches('personalization-snapshot', overlay),
])
const requests: GenerateOptions[] = []
ctx.llm.registerAdapter(['prompt-fixture'], new class extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}())
try {
  const api = createApiProxy(ctx, { cwd: process.cwd(), defaultModelSelection: () => ({ provider: 'prompt-fixture', model: 'fixture' }) })
  const initial = await api.settings.readInstructions({ rpcId: RpcId('read'), payload: {} })
  if (!initial.result.ok) throw new Error(initial.result.error.message)
  let revision = initial.result.value.revision
  async function save(content: string) {
    const response = await api.settings.writeInstructions({ rpcId: RpcId('save'), payload: { content, expectedRevision: revision } })
    if (!response.result.ok) throw new Error(response.result.error.message)
    revision = response.result.value.revision
  }
  await save('Use concise Vietnamese answers.')
  const handle = await ctx.agents.create({
    sessionId: SessionId('personalization-fixture'), meta: { cwd: process.cwd() },
    agentOptions: { provider: 'prompt-fixture', model: 'fixture' },
  })
  const turns = []
  try {
    for (const stage of ['saved', 'unsaved', 'updated', 'cleared']) {
      if (stage === 'updated') await save('Use detailed Vietnamese answers.')
      if (stage === 'cleared') await save('')
      const offset = handle.agent.session.events.length
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Check ${stage}` }] }))
      await handle.agent.whenIdle()
      const request = requests.at(-1)
      if (request === undefined || requests.length !== turns.length + 1) throw new Error('expected one request per turn')
      const entered = handle.agent.session.events.slice(offset).flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'agent-instructions' ? [event.data] : [])
      turns.push({
        stage,
        changes: entered.flatMap(message => message.source.kind === 'agent-instructions' ? message.source.changes.map(change => change.action) : []),
        loggedInRequest: entered.every(message => request.messages.some(item => item.id === message.id)),
        instructions: request.messages.filter(message => message.source.kind === 'agent-instructions')
          .map(message => ({ role: message.role, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') })),
      })
    }
  } finally {
    await handle.dispose()
  }
  await ctx.settings.update(settingsNamespace('personalization'), { personality: 'friendly' })
  const tones = []
  for (const existing of [true, false]) {
    const toneHandle = existing
      ? await ctx.agents.resume({ resumeSessionId: SessionId('personalization-fixture'), agentOptions: { provider: 'prompt-fixture', model: 'fixture' } })
      : await ctx.agents.create({ sessionId: SessionId('new-personality-fixture'), agentOptions: { provider: 'prompt-fixture', model: 'fixture' } })
    try {
      const count = requests.length
      toneHandle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check tone' }] }))
      await toneHandle.agent.whenIdle()
      if (requests.length !== count + 1) throw new Error('expected one tone request')
      const request = requests.at(-1)!
      tones.push({ existing, pragmatic: request.system?.includes('direct, matter-of-fact tone'), friendly: request.system?.includes('warm, encouraging') })
    } finally {
      await toneHandle.dispose()
    }
  }
  process.stdout.write(`${JSON.stringify({ turns, tones })}\n`)
} finally {
  await ctx.fiber.dispose()
}
