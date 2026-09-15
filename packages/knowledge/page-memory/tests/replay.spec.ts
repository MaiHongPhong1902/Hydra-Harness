import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { compareReplayPolicies, extractReplayRuns, replayRuns, type ReplayRun } from '../src/replay.ts'

describe('recorded page-memory replay', () => {
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
