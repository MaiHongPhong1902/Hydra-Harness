/**
 * Registry tests for `@hydra/harness-shell-env`: built-in facts, contributor
 * ownership and validation, collection ordering, effect-scoped disposal, and
 * the explicit disposer contract.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import { CallId } from '@hydra/harness-llm'
import type { Agent } from '@hydra/harness-agent'
import type { ToolExecution } from '@hydra/harness-tools'
import { ShellEnvRegistry } from '@hydra/harness-shell-env'
import * as BashEnvPlugin from '@hydra/harness-shell-env'

const testToolSignal = new AbortController().signal

afterEach(() => vi.unstubAllEnvs())

function execution(sessionId?: string): ToolExecution {
  return {
    signal: testToolSignal,
    token: Symbol('bash-env-test') as ToolExecution['token'],
    callId: CallId('bash-env-call'),
    rootCallId: CallId('bash-env-call'),
    name: 'bash',
    arguments: { command: 'true' },
    ...(sessionId === undefined
      ? {}
      : { agent: { session: { header: { version: 0, id: sessionId, createdAt: 0 } } } as Agent }),
  }
}

describe('ShellEnvRegistry', () => {
  it('collects unconditional shell facts and the current agent session id', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { bhHome: './test-bh-home' })

    expect(registry.collect(execution())).toEqual({
      BH_HOME: resolve('./test-bh-home'),
      BH_SHELL: '1',
    })
    expect(registry.collect(execution('session-a'))).toEqual({
      BH_HOME: resolve('./test-bh-home'),
      BH_SESSION_ID: 'session-a',
      BH_SHELL: '1',
    })
  })

  it('resolves BH_HOME from the ambient override or the user-home default', () => {
    vi.stubEnv('BH_HOME', './ambient-bh-home')
    const fromEnvironment = new ShellEnvRegistry(new Context())
    expect(fromEnvironment.collect(execution()).BH_HOME).toBe(resolve('./ambient-bh-home'))

    vi.stubEnv('BH_HOME', undefined)
    const fromDefault = new ShellEnvRegistry(new Context())
    expect(fromDefault.collect(execution()).BH_HOME).toBe(join(homedir(), '.bh'))
  })

  it('collects declared contributor variables and omits unavailable values', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { bhHome: './test-bh-home' })
    registry.register({
      name: 'optional-session-fact',
      variables: {
        BH_SESSION_OPTIONAL: { description: 'Optional session-scoped test fact.' },
      },
      resolve: exec => exec.agent === undefined ? {} : { BH_SESSION_OPTIONAL: exec.agent.session.header.id },
    })
    registry.register({
      name: 'always-available-fact',
      variables: {
        BH_ALWAYS_AVAILABLE: { description: 'Always-available test fact.' },
      },
      resolve: () => ({ BH_ALWAYS_AVAILABLE: 'yes' }),
    })

    expect(registry.collect(execution())).not.toHaveProperty('BH_SESSION_OPTIONAL')
    expect(registry.collect(execution()).BH_ALWAYS_AVAILABLE).toBe('yes')
    expect(registry.collect(execution('session-b')).BH_SESSION_OPTIONAL).toBe('session-b')
    expect(registry.list()).toEqual([
      {
        contributor: 'always-available-fact',
        description: 'Always-available test fact.',
        key: 'BH_ALWAYS_AVAILABLE',
      },
      {
        contributor: 'optional-session-fact',
        description: 'Optional session-scoped test fact.',
        key: 'BH_SESSION_OPTIONAL',
      },
    ])
  })

  it('rejects duplicate variable ownership at registration time', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { bhHome: './test-bh-home' })
    registry.register({
      name: 'first',
      variables: { BH_SHARED: { description: 'First owner.' } },
      resolve: () => ({ BH_SHARED: 'first' }),
    })

    expect(() => registry.register({
      name: 'second',
      variables: { BH_SHARED: { description: 'Second owner.' } },
      resolve: () => ({ BH_SHARED: 'second' }),
    })).toThrow(/BH_SHARED.*first.*second|BH_SHARED.*second.*first/)
  })

  it('rejects duplicate contributor names and malformed declarations', () => {
    const registry = new ShellEnvRegistry(new Context(), { bhHome: './test-bh-home' })
    registry.register({
      name: 'declared',
      variables: { BH_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({}),
    })

    expect(() => registry.register({
      name: 'declared',
      variables: { BH_ANOTHER: { description: 'Another fact.' } },
      resolve: () => ({}),
    })).toThrow(/already registered/)
    expect(() => registry.register({
      name: ' ',
      variables: { BH_BLANK_NAME: { description: 'Blank owner.' } },
      resolve: () => ({}),
    })).toThrow(/name must be non-empty/)
    expect(() => registry.register({
      name: 'invalid-key',
      variables: { bh_invalid: { description: 'Invalid key.' } } as unknown as Record<'BH_INVALID', { description: string }>,
      resolve: () => ({}),
    })).toThrow(/invalid key/)
    expect(() => registry.register({
      name: 'reserved-key',
      variables: { BH_HOME: { description: 'Reserved key.' } },
      resolve: () => ({}),
    })).toThrow(/reserved key/)
    expect(() => registry.register({
      name: 'blank-description',
      variables: { BH_BLANK_DESCRIPTION: { description: ' ' } },
      resolve: () => ({}),
    })).toThrow(/must describe/)
  })

  it('rejects undeclared variables returned by a contributor', () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { bhHome: './test-bh-home' })
    registry.register({
      name: 'drifted-provider',
      variables: { BH_DECLARED: { description: 'Declared fact.' } },
      resolve: () => ({ BH_UNDECLARED: 'bad' }),
    })

    expect(() => registry.collect(execution())).toThrow(/drifted-provider.*BH_UNDECLARED/)
  })

  it('rejects non-string values returned by a contributor', () => {
    const registry = new ShellEnvRegistry(new Context(), { bhHome: './test-bh-home' })
    registry.register({
      name: 'wrong-value-type',
      variables: { BH_STRING: { description: 'String fact.' } },
      resolve: () => ({ BH_STRING: 42 }) as unknown as Record<'BH_STRING', string>,
    })

    expect(() => registry.collect(execution())).toThrow(/wrong-value-type.*non-string.*BH_STRING/)
  })

  it('removes an effect-scoped contributor when its plugin is disposed', async () => {
    const ctx = new Context()
    const registry = new ShellEnvRegistry(ctx, { bhHome: './test-bh-home' })
    const fiber = await ctx.plugin({
      inject: ['shellEnv'],
      apply(inner: Context) {
        inner.shellEnv.register({
          name: 'temporary',
          variables: { BH_TEMPORARY: { description: 'Temporary fact.' } },
          resolve: () => ({ BH_TEMPORARY: 'present' }),
        })
      },
    })

    expect(registry.collect(execution()).BH_TEMPORARY).toBe('present')
    await fiber.dispose()
    expect(registry.collect(execution())).not.toHaveProperty('BH_TEMPORARY')
  })

  it('returns an explicit contributor disposer', () => {
    const registry = new ShellEnvRegistry(new Context(), { bhHome: './test-bh-home' })
    const dispose = registry.register({
      name: 'explicit-disposal',
      variables: { BH_EXPLICIT_DISPOSAL: { description: 'Explicitly disposed fact.' } },
      resolve: () => ({ BH_EXPLICIT_DISPOSAL: 'present' }),
    })

    expect(registry.collect(execution()).BH_EXPLICIT_DISPOSAL).toBe('present')
    dispose()
    expect(registry.collect(execution())).not.toHaveProperty('BH_EXPLICIT_DISPOSAL')
  })

  it('the plugin registers the service and the persistence contributor on load', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv).toBeInstanceOf(ShellEnvRegistry)
    expect(ctx.shellEnv.list()).toEqual([
      {
        contributor: 'session-persistence',
        description: 'Absolute target path of the current session JSONL when the active persistence backend provides one.',
        key: 'BH_SESSION_JSONL',
      },
    ])
  })

  it('the persistence contributor resolves BH_SESSION_JSONL only for a jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'jsonl' as const, path: 'C:\\sessions\\s.jsonl' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p')).BH_SESSION_JSONL).toBe('C:\\sessions\\s.jsonl')
  })

  it('the persistence contributor omits the variable for a non-jsonl backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    ctx.provide('sessionPersistence', {
      locate: () => ({ kind: 'sqlite' as const, path: 'C:\\sessions\\s.db' }),
    })
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('BH_SESSION_JSONL')
  })

  it('the persistence contributor omits the variable without a persistence backend', async () => {
    const ctx = new Context()
    await ctx.plugin(BashEnvPlugin)
    expect(ctx.shellEnv.collect(execution('sess-p'))).not.toHaveProperty('BH_SESSION_JSONL')
  })
})
