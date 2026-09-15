/** Offline Page Memory prefix replay. Reads a session log and prints aggregate metrics only. */
import { readFile, stat } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { compareReplayPolicies, extractReplayRuns } from '@hydra/harness-page-memory/src/replay.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'max-bytes': { type: 'string', default: '16777216' },
    'max-steps': { type: 'string', default: '256' },
    'max-calls': { type: 'string', default: '12' },
    holdout: { type: 'string', default: '1' },
  },
})
if (positionals.length !== 1) throw new Error('Usage: node --import tsx/esm examples/acp-agent/page-memory-replay.mjs <session.jsonl> [--holdout 1] [--max-calls 12]')
const limits = Object.fromEntries(Object.entries(values).map(([key, value]) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${key} must be a positive integer`)
  return [key, number]
}))
const path = positionals[0]
if ((await stat(path)).size > limits['max-bytes']) throw new Error('Session log exceeds --max-bytes')
const input = await readFile(path)
if (input.length > limits['max-bytes']) throw new Error('Session log exceeds --max-bytes')
const records = input.toString('utf8').split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line))
const runs = extractReplayRuns(records, limits['max-steps'])
const report = compareReplayPolicies(runs, {
  reliability: prefix => prefix.steps.at(-1)?.outcome === 'failure' ? 'stop' : 'continue',
  cost: prefix => prefix.steps.length >= limits['max-calls'] ? 'stop' : 'continue',
}, limits.holdout)
process.stdout.write(`${JSON.stringify({
  ...report,
  limitation: 'Only observed sequential prefixes are replayed. Unverified task outcomes remain unknown. This report does not authorize or deploy a Browser policy.',
}, null, 2)}\n`)
