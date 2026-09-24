import { createUserMessage } from '@hydra/harness-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@hydra/cordis'
import Loader from '@hydra/cordis-plugin-loader'
import { SessionId, type SessionEvent } from '@hydra/harness-session'
import { defineContentToolFixture } from '@hydra/harness-tools'
import type { Agent } from '@hydra/harness-agent'
import AgentLoop from '@hydra/harness-agent-loop'
import { mountAgentLoopTestDependencies } from '@hydra/harness-agent-loop-testkit'
import { LocalBashExecutor } from '@hydra/harness-bash-local'
import LocalSubprocessRuntime from '@hydra/harness-subprocess-local'
import { scopeTarget } from '@hydra/harness-scope'
import SubagentRuntime, { SubagentRunId } from '@hydra/harness-subagent'
import * as HooksCodex from '@hydra/harness-hooks-codex'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop Codex bridge tests with a mock model, the real loop and bash
 * executor, and shell hooks from a temporary config. Covers regex matching,
 * block-only decisions, and the seven-event subset.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-hooks-codex-'))
  dirs.push(dir)
  return dir
}
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
function writeHooks(dir: string, hooks: unknown): void {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
}

async function harness(dir: string, adapter: MockAdapter, beforeHooks?: (ctx: Context) => void): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  beforeHooks?.(ctx)
  await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'test-model' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}
function events(agent: Agent): SessionEvent[] { return [...agent.session.events] }
function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

/** Poll `predicate` until true or the deadline passes (detached hook effects can't be awaited directly). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-codex bridge', () => {
  it('a PreToolUse hook (exit 2) denies a tool the regex matcher matches as a substring', async () => {
    const dir = configDir()
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\necho "codex blocked it" >&2\nexit 2\n')
    // Codex regex matcher: "Bash" is /Bash/ — matches the tool name "Bash".
    writeHooks(dir, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: deny }] }] })

    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'no' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run ls' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('codex blocked it'))).toBe(true)
    expect(events(agent).some(e => e.type === 'hook/invoked' && e.data.dialect === 'codex' && e.data.point === 'PreToolUse')).toBe(true)
  })

  it('a Stop hook (exit 2) forces the turn to continue with the reason as steering', async () => {
    const dir = configDir()
    // Stop ignores its malformed matcher field. Block once with a marker;
    // until the loop guard lands, an always-blocking hook would never finish.
    const marker = join(dir, 'fired')
    const cont = script(dir, 'cont.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\necho "keep going: address the goal" >&2\nexit 2\n`)
    writeHooks(dir, { Stop: [{ matcher: '[', hooks: [{ type: 'command', command: cont }] }] })

    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer after goal')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('keep going: address the goal')
  }, 15_000) // Two real hook subprocesses and agent steps need startup and teardown headroom under load.

  it('turn cancellation aborts and reaps a running UserPromptSubmit hook before idle', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    const slow = script(dir, 'slow-prompt.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: slow }] }] })

    const adapter = new MockAdapter([textResponse('must not run')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('cancel-prompt-hook'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel the hook' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())

    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })
    await idle

    expect(() => process.kill(pid, 0)).toThrow()
    expect(adapter.requests).toHaveLength(0)
    expect(events(agent).filter(event => event.type === 'turn/start' || event.type === 'hook/invoked'
      || event.type === 'hook/result' || event.type === 'turn/end').map(event => event.type))
      .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
  })

  it('keeps an unsupported Codex event inert when no matching Hydra seam exists', async () => {
    const dir = configDir()
    const s = script(dir, 'x.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { PermissionRequest: [{ hooks: [{ type: 'command', command: s }] }] })

    const adapter = new MockAdapter([textResponse('fine')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('runs SubagentStart and SubagentStop hooks on the shared lifecycle seam', async () => {
    const dir = configDir()
    const startMarker = join(dir, 'start-ran')
    const stopMarker = join(dir, 'stop-ran')
    const start = script(dir, 'start.sh', `#!/usr/bin/env bash\ntouch "${startMarker}"\n`)
    const stop = script(dir, 'stop.sh', `#!/usr/bin/env bash\ntouch "${stopMarker}"\n`)
    writeHooks(dir, {
      SubagentStart: [{ hooks: [{ type: 'command', command: start }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: stop }] }],
    })
    const ctx = await harness(dir, new MockAdapter([]))
    ctx.emit(subagentCarrier(ctx), 'subagent/start', {
      runId: SubagentRunId('run-1'), provider: 'inproc', id: SessionId('child-1'), local: false,
    })
    ctx.emit(subagentCarrier(ctx), 'subagent/end', {
      runId: SubagentRunId('run-1'), provider: 'inproc', id: SessionId('child-1'), local: false, stopReason: 'completed',
    })
    await waitFor(() => existsSync(startMarker) && existsSync(stopMarker))
  })

  it('logs an unexpected SubagentStop failure instead of swallowing it', async () => {
    const dir = configDir()
    const stop = script(dir, 'stop.sh', '#!/usr/bin/env bash\nexit 0\n')
    writeHooks(dir, { SubagentStop: [{ hooks: [{ type: 'command', command: stop }] }] })
    const ctx = await harness(dir, new MockAdapter([]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never

    // A malformed runtime payload makes JSON serialization reject before the
    // runner can normalize the failure; the detached bridge must still report it.
    ctx.emit(subagentCarrier(ctx), 'subagent/end', {
      runId: SubagentRunId('run-reject'), provider: 'inproc', id: 1n as unknown as SessionId, local: false, stopReason: 'completed',
    })
    await waitFor(() => warn.mock.calls.some(call => String(call[0]).includes('SubagentStop hook failed')))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SubagentStop hook failed'))
  })

  it('injects start context into a registered child and retains its stop payload', async () => {
    const dir = configDir()
    const stopPayload = join(dir, 'stop.json')
    const start = script(dir, 'start.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"child guidance"}}\'\n')
    const stop = script(dir, 'stop.sh', `#!/usr/bin/env bash\ncat > "${stopPayload}"\n`)
    writeHooks(dir, {
      SubagentStart: [{ hooks: [{ type: 'command', command: start }] }],
      SubagentStop: [{ hooks: [{ type: 'command', command: stop }] }],
    })
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(dir, adapter)
    const handle = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('registered-child'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    const child = handle.agent
    const inject = vi.spyOn(child, 'inject')
    const info = { runId: SubagentRunId('registered-run'), provider: 'inproc', id: child.id, local: true }
    ctx.emit(subagentCarrier(ctx), 'subagent/start', info)
    await waitFor(() => inject.mock.calls.length === 1)
    child.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await child.whenIdle()
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('child guidance')
    await handle.dispose()
    ctx.emit(subagentCarrier(ctx), 'subagent/end', { ...info, stopReason: 'completed' })
    await waitFor(() => existsSync(stopPayload) && readFileSync(stopPayload, 'utf8').length > 0)
    expect(JSON.parse(readFileSync(stopPayload, 'utf8'))).toMatchObject({
      hook_event_name: 'SubagentStop', session_id: child.id, agent_id: child.id, stop_hook_active: false,
    })
  })

  it('reports a child context injection failure without rejecting lifecycle dispatch', async () => {
    const dir = configDir()
    const start = script(dir, 'start.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"child guidance"}}\'\n')
    writeHooks(dir, { SubagentStart: [{ hooks: [{ type: 'command', command: start }] }] })
    const ctx = await harness(dir, new MockAdapter([]))
    const child = ctx.agentLoop.create(SessionId('failed-child'), { provider: 'mock', model: 'mock' })
    vi.spyOn(child, 'inject').mockImplementation(() => { throw new Error('injection failed') })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.emit(subagentCarrier(ctx), 'subagent/start', {
      runId: SubagentRunId('failed-run'), provider: 'inproc', id: child.id, local: true,
    })
    await waitFor(() => warn.mock.calls.some(call => String(call[0]).includes('SubagentStart hook failed')))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('injection failed'))
  })

  it('a missing config registers no hooks and does not crash', async () => {
    const dir = configDir() // no hooks.json written
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('an invalid regex matcher is reported and registers no hooks', async () => {
    const dir = configDir()
    writeHooks(dir, {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
      PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'exit 2' }] }],
    })
    const adapter = new MockAdapter([textResponse('ok')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, (ctx) => { ctx.logger.warn = warn as never })
    const agent = ctx.agentLoop.create(SessionId('invalid-codex-matcher'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(event => event.type === 'hook/invoked')).toBe(false)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'invalid codex regex matcher "[" on event "PreToolUse"',
    ))
  })

  it('disposing the bridge fiber removes its listeners (HMR safety)', async () => {
    const dir = configDir()
    // A leaked listener would let this blocking hook veto the prompt and log an invocation; a
    // no-op hook would pass even when leaked.
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: deny }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    await fiber.dispose()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // not blocked → the listener is gone
    expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false) // no hook ran
  })

  it('disposing the bridge aborts a still-running SessionStart hook and drains to quiescence', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    // Record the PID and marker before sleeping past the suite timeout. Disposal must abort the
    // tracked process through `runPoint`, not await its natural exit.
    const slow = script(dir, 'slow.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { SessionStart: [{ hooks: [{ type: 'command', command: slow }] }] })
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' }) // fires agent/session-start
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await fiber.dispose()
    // Disposal reaches quiescence only after the aborted run settles and the process is reaped, so
    // `kill(pid, 0)` must report ESRCH. Untracked fire-and-forget work would remain.
    expect(() => process.kill(pid, 0)).toThrow()
    // runHook resolves an aborted run as a non-blocking error, so draining must
    // not log a rejected continuation.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in HooksCodex).toBe(false)
    expect(HooksCodex.name).toBe('hooks-codex')
    expect(HooksCodex.inject).toEqual(['shell'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(HooksCodex) as Record<string, unknown>
    expect(unwrapped).toBe(HooksCodex)
    expect(unwrapped.name).toBe('hooks-codex')
    expect(unwrapped.inject).toEqual(['shell'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
