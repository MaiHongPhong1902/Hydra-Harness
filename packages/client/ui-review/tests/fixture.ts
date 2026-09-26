import type { ReviewChange } from '@hydra1902/harness-fs-review/client'

export const change = (overrides: Partial<ReviewChange> = {}): ReviewChange => ({
  version: 1, id: 'a7c57a31-4134-4880-85e5-cb2d2626d281' as never,
  sessionId: 'owner' as never, callId: 'call' as never, rootCallId: 'call' as never,
  toolName: 'edit', seq: 5, turnSeq: 1, stepSeq: 3, parentSessionId: null,
  agentPreset: null, createdAt: 1788825600000, workspace: '/workspace', path: 'a.txt',
  operation: 'edit', status: 'modified', state: 'active', beforeHash: 'a'.repeat(64),
  afterHash: 'b'.repeat(64), reversible: true, binary: false, truncated: false,
  additions: 1, deletions: 1, hunks: [{ header: '@@ -1,1 +1,1 @@', lines: ['-A', '+B'] }],
  ...overrides,
})

export const ok = <T>(value: T) => ({ rpcId: 'rpc' as never, result: { ok: true as const, value } })
