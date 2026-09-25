import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { compareReplayPolicies, extractReplayRuns, replayRuns, type ReplayRun } from '../src/replay.ts'

function call(id: string, name: string, args: unknown = {}, time?: number) {
  return { type: 'tool/call', ...(time === undefined ? {} : { time }), data: { callId: id, name, arguments: JSON.stringify(args) } }
}

function result(id: string, isError = false, content: unknown[] = [], time?: number) {
  return { type: 'tool/result', ...(time === undefined ? {} : { time }),
    data: { message: { content: [{ toolCallId: id, isError, content }] } } }
}

const selected = [call('select', 'page_memory_get', { task: 'save' }), result('select')]

describe('recorded page-memory replay', () => {
  it('rejects invalid budgets, duplicate calls and reserved policy names', () => {
    for (const max of [0, -1, 1.5]) expect(() => extractReplayRuns([], max)).toThrow('maxSteps')
    expect(() => extractReplayRuns([call('same', 'browser_click'), call('same', 'browser_click')], 2)).toThrow('duplicate')
    const runs: ReplayRun[] = [1, 2].map(id => ({ id, taskDigest: 'task', steps: [], supported: true }))
    for (const count of [0, 2, 1.5]) expect(() => compareReplayPolicies(runs, {}, count)).toThrow('holdout')
    expect(() => compareReplayPolicies(runs, { baseline: () => 'stop' }, 1)).toThrow('reserved')
  })

  it('ignores unrelated calls and unselected browser activity without exposing arguments', () => {
    expect(extractReplayRuns([
      call('plain', 'echo'), result('plain'), call('browser', 'browser_click'),
      call('overlap', 'browser_click'), result('browser'), result('overlap'),
      call('memory', 'page_memory_get'), result('memory'),
      { type: 'tool/result', data: { message: { content: [null, { type: 'text', text: 'unrelated' }] } } },
    ], 4)).toEqual([])
  })

  it('splits changed tasks, records failures and measured calls, and discards irrelevant memory tools', () => {
    const runs = extractReplayRuns([
      ...selected, call('again', 'page_memory_get', { task: 'save' }), result('again'),
      call('click', 'browser_click', {}, 1), result('click', true, [], 4),
      call('other', 'page_memory_get', { task: 'find' }), result('other'),
      call('ignored', 'page_memory_delete'), result('ignored'),
      call('get-failed', 'page_memory_get', { task: 'not-selected' }), result('get-failed', true),
      call('save', 'page_memory_upsert'), result('save', false, [null, { type: 'text', text: 'not verified' }]),
      call('verified', 'page_memory_upsert'), result('verified', false, [{ type: 'text', text: 'Page memory verified: find' }]),
    ], 8)
    expect(runs).toHaveLength(2)
    expect(runs[0]?.steps).toEqual([{ kind: 'browser_click', outcome: 'failure', durationMs: 3, verifiedPostcondition: false }])
    expect(runs[1]?.steps.map(step => step.verifiedPostcondition)).toEqual([false, true])
    expect(runs[0]?.taskDigest).not.toBe(runs[1]?.taskDigest)
  })

  it.each(['overlap', 'unfinished', 'turn', 'backwards'] as const)('marks %s histories unsupported', (kind) => {
    const records: unknown[] = [...selected, call('one', 'browser_click', {}, 5)]
    if (kind === 'overlap') records.push(call('two', 'browser_click'), result('two'), result('one'))
    if (kind === 'turn') records.push({ type: 'turn/end' })
    if (kind === 'backwards') records.push(result('one', false, [], 4))
    const runs = extractReplayRuns(records, 4)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.supported).toBe(false)
    expect(replayRuns(runs, () => 'continue')).toMatchObject({ unsupported: 1, calls: 0 })
  })

  it('tracks nested Code Mode calls and abandons calls across turn boundaries', () => {
    const start = (subCallId: string, name: string, args: unknown = {}) => ({ type: 'tool/code-dispatch-start',
      data: { subCallId, name, arguments: args } })
    const done = (subCallId: string, name: string) => ({ type: 'tool/code-dispatch',
      data: { subCallId, name, arguments: {}, isError: false, content: [] } })
    const runs = extractReplayRuns([
      start('unselected', 'browser_click'), { type: 'turn/start' },
      start('select', 'page_memory_get', { task: 'save' }), done('select', 'page_memory_get'),
      start('browser', 'browser_click'), done('browser', 'browser_click'), done('unknown', 'browser_click'),
      start('unfinished', 'browser_click'), { type: 'turn/end' },
      call('unselected', 'browser_click'),
    ], 4)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ supported: false, steps: [{ kind: 'browser_click' }] })
  })

  it('selects fewer training calls only when verified outcomes are preserved', () => {
    const step = { kind: 'browser_click', outcome: 'failure', durationMs: null, verifiedPostcondition: false } as const
    const saved = { ...step, outcome: 'success', verifiedPostcondition: true } as const
    const runs: ReplayRun[] = [
      { id: 1, taskDigest: 'unknown', steps: [step, step], supported: true },
      { id: 2, taskDigest: 'verified', steps: [saved], supported: true },
      { id: 3, taskDigest: 'holdout', steps: [step, saved], supported: true },
    ]
    const report = compareReplayPolicies(runs, { afterFailure: prefix => prefix.steps.length > 0 ? 'stop' : 'continue',
      never: () => 'stop' }, 1)
    expect(report.selected).toBe('afterFailure')
    expect(report.holdoutPreservesVerified).toBe(false)
  })

  it('extracts the real Loader transcript without retaining Browser arguments or inferring task completion', async () => {
    const file = new URL('../../../../examples/acp-agent/tests/snapshots/page-memory-turn/session.jsonl', import.meta.url)
    const records: unknown[] = (await readFile(file, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line) as unknown)
    const runs = extractReplayRuns(records, 256)
    expect(runs).toHaveLength(2)
    expect(runs.every(run => run.supported)).toBe(true)
    const metrics = replayRuns(runs, () => 'continue')
    expect(metrics.verified).toBe(1)
    expect(metrics.unknown).toBe(1)
    expect(metrics.unmeasuredCalls).toBe(metrics.calls)
    expect(JSON.stringify(runs)).not.toMatch(/Alice|Bea|shop\.test|requester|button\[/u)
    expect(compareReplayPolicies(runs, {}, 1).selected).toBe('baseline')
    expect(extractReplayRuns(records, 1).every(run => !run.supported)).toBe(true)
  })

  it('reveals only observed prefixes and keeps baseline on training ties regardless of holdout outcomes', () => {
    const failed = { kind: 'browser_click', outcome: 'failure', durationMs: 5, verifiedPostcondition: false } as const
    const saved = { kind: 'page_memory_upsert', outcome: 'success', durationMs: 3, verifiedPostcondition: true } as const
    const runs: ReplayRun[] = [
      { id: 1, taskDigest: 'task', steps: [failed], supported: true },
      { id: 2, taskDigest: 'task', steps: [failed, saved], supported: true },
    ]
    const seen: number[] = []
    const metrics = replayRuns([runs[1]!], (prefix) => {
      seen.push(prefix.steps.length)
      expect(Object.isFrozen(prefix.steps)).toBe(true)
      expect(prefix.steps.some(step => step.verifiedPostcondition)).toBe(false)
      return prefix.steps.length === 1 ? 'stop' : 'continue'
    })
    expect(seen).toEqual([0, 1])
    expect(metrics).toMatchObject({ verified: 0, unknown: 1, stopped: 1, calls: 1, measuredMs: 5 })
    const report = compareReplayPolicies(runs, { reliability: prefix => prefix.steps.at(-1)?.outcome === 'failure' ? 'stop' : 'continue' }, 1)
    expect(report.selected).toBe('baseline')
    expect(report.results[1]?.holdout.verified).toBe(0)
    expect(report.runtimePolicy).toBe('baseline')
  })
})
