import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import config from './config.json' with { type: 'json' }

import {
  countVisibleUnits,
  nextResolvingIssueStatus,
  parseReferences,
  retainIssueReferences,
  resolvingIssueStatusCommand,
  requiresPullRequestPolicy,
  validateBody,
  validateIssue,
  validatePullRequest,
} from './policy.mjs'

const withDetails = (summary) =>
  `${summary}\n\n<details><summary>验收与细节</summary>待补充。</details>`

const legalIssue = {
  title: '完成议题管理校验',
  body: withDetails('完成议题管理校验。'),
  assignees: [],
  labels: [],
  type: 'Idea',
  priority: null,
  status: 'In review',
  state: 'open',
  stateReason: null,
}

const canonicalKinds = [
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
]

test('PR checks respect repository support for custom Issue fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-issue-policy-'))
  const eventPath = join(dir, 'event.json')
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 16 } }))
  t.after(async () => { await unlink(eventPath); await rmdir(dir) })
  const base = `/repos/${config.organization}/${config.repository}`
  for (const scenario of [
    { owner: 'User', fieldsStatus: 404, success: true },
    { owner: 'Organization', fieldsStatus: 200, success: true },
    { owner: 'Organization', fieldsStatus: 200, priority: 'P1', error: 'PR Priority should be p1' },
    { owner: 'Organization', fieldsStatus: 404, error: '404' },
    { owner: 'Organization', fieldsStatus: 403, error: '403' },
    { owner: 'User', repositoryStatus: 403, error: '403' },
  ]) {
    await t.test(JSON.stringify(scenario), async (t) => {
      const requests = []
      const server = createServer((request, response) => {
        requests.push(request.url)
        let status = 200
        let body
        switch (request.url) {
          case base:
            status = scenario.repositoryStatus ?? 200
            body = { owner: { type: scenario.owner } }
            break
          case `${base}/pulls/16`:
            body = { body: 'Closes #17', user: { type: 'User' }, draft: false, labels: [{ name: 'kind/bug-fix' }, { name: 'area/ci' }] }
            break
          case `${base}/pulls/16/requested_reviewers`:
            body = { users: [{ login: 'reviewer' }], teams: [] }
            break
          case `${base}/pulls/16/reviews?per_page=100`:
            body = []
            break
          case `${base}/issues/17`:
            body = { title: 'CI', body: '', assignees: [], labels: [], state: 'open' }
            break
          case `${base}/issues/17/issue-field-values?per_page=100`:
            status = scenario.fieldsStatus
            body = scenario.priority ? [{ issue_field_name: config.priorityField, single_select_option: { name: scenario.priority } }] : []
            break
          default:
            status = 500
            body = { message: `Unexpected request: ${request.url}` }
        }
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(body))
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      t.after(() => new Promise(resolve => server.close(resolve)))
      const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./policy.mjs', import.meta.url)), 'pr'], {
        env: { ...process.env, GH_TOKEN: 'local-fixture', GITHUB_TOKEN: '', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_EVENT_PATH: eventPath },
        timeout: 10000,
      }).then(value => ({ ...value, code: 0 }), error => error)
      if (scenario.success) {
        assert.equal(result.code, 0, result.stderr)
        assert.match(result.stdout, /Issue policy passed/)
      } else {
        assert.equal(result.code, 1)
        assert.ok(`${result.stdout}${result.stderr}`.includes(scenario.error))
      }
      assert.equal(requests.some(path => path.includes('/issue-field-values')), scenario.owner === 'Organization')
    })
  }
})

// Keep an independent oracle rather than importing the implementation's reserved set.
const legacyLabels = [
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
]

const reviewedPull = (labels) => ({
  isDraft: false,
  authorType: 'User',
  reviewRequestCount: 1,
  reviewCount: 0,
  labels,
  references: { all: [2], resolving: [], related: [2] },
  issues: new Map([[2, { priority: null }]]),
})

test('counts only text outside details', () => {
  assert.deepEqual(countVisibleUnits('支持 GitHub Project。<details>隐藏文字</details>'), {
    units: 4,
    balanced: true,
    detailsCount: 1,
    allCollapsed: true,
  })
})

test('requires a balanced default-collapsed details region', () => {
  assert.deepEqual(validateBody({ body: '完成工作。', assignees: [] }), [
    'Body must include a default-collapsed <details> region',
  ])
  assert.deepEqual(
    validateBody({
      body: '完成工作。\n\n<details open><summary>细节</summary>待补充。</details>',
      assignees: [],
    }),
    ['details must be collapsed by default; do not set open'],
  )
  assert.deepEqual(
    validateBody({ body: '完成工作。\n\n<details><summary>细节</summary>', assignees: [] }),
    ['details tags must be properly paired and closed'],
  )
})

test('requires Owner for multiple assignees', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('完成工作。'),
      assignees: ['tianyicui', 'tianyicui-bot'],
    }),
    ['When there are multiple Assignees, the first non-blank line must be Owner: @login'],
  )
})

test('accepts an intended Owner while assignment permission is pending', () => {
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: [],
    }),
    [],
  )
  assert.deepEqual(
    validateBody({
      body: withDetails('Owner: @octocat\n\n完成工作。'),
      assignees: ['hubot'],
    }),
    ['When there are zero or one Assignee, do not write an Owner line'],
  )
})

test('allows optional metadata in every open Status', () => {
  assert.deepEqual(validateIssue(legalIssue), [])
  for (const status of ['Inbox', 'Backlog', 'Ready', 'In progress', 'In review']) {
    assert.deepEqual(validateIssue({ ...legalIssue, status }), [])
  }
})

test('rejects metadata prefixes in an Issue title', () => {
  const errors = validateIssue({ ...legalIssue, title: '[Bug] 修复恢复错误' })
  assert.ok(errors.includes('Issue title must not carry a Type, Priority, Status, area, or Owner prefix'))
})

test('reserves PR kind and legacy labels for pull requests', () => {
  for (const label of [
    ...canonicalKinds,
    'kind/experimental',
    ...legacyLabels,
  ]) {
    assert.ok(
      validateIssue({ ...legalIssue, labels: [label] }).some((error) =>
        error.startsWith('Issue must not use PR kind or legacy labels: '),
      ),
      label,
    )
  }
  assert.deepEqual(validateIssue({ ...legalIssue, labels: ['area/web', 'source/member'] }), [])
})

test('keeps terminal Status aligned with the native close reason', () => {
  assert.deepEqual(
    validateIssue({ ...legalIssue, status: 'Done', state: 'closed', stateReason: 'completed' }),
    [],
  )
  assert.deepEqual(
    validateIssue({
      ...legalIssue,
      status: 'No action',
      state: 'closed',
      stateReason: 'not_planned',
    }),
    [],
  )
  assert.ok(validateIssue({ ...legalIssue, status: 'Done' }).includes('Done must correspond to a Completed close reason'))
})

test('separates resolving and informational references', () => {
  assert.deepEqual(
    parseReferences({
      body: 'Fixes #12\nRelated to #4\nRefs hydraharness/hydra-test#7',
      repository: 'hydraharness/hydra-test',
    }),
    { all: [4, 7, 12], resolving: [12], related: [4, 7] },
  )
})

test('does not treat pull request references as Issue associations', () => {
  const references = {
    all: [123, 1180, 1181],
    resolving: [123, 1180],
    related: [1181],
  }
  const issues = new Map([
    [1180, {}],
    [1181, {}],
  ])

  assert.deepEqual(retainIssueReferences(references, issues), {
    all: [1180, 1181],
    resolving: [1180],
    related: [1181],
  })
})

test('allows informational references without cross-object constraints', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/cleanup', 'area/infra'],
    references: { all: [4], resolving: [], related: [4] },
    issues: new Map([[4, { type: 'Bug', priority: 'P0', labels: ['area/web'] }]]),
  })
  assert.deepEqual(errors, [])
})

test('enforces highest resolving Priority without Type or area synchronization', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 1,
    labels: ['kind/cleanup', 'p0', 'area/web'],
    references: { all: [2, 3], resolving: [2, 3], related: [] },
    issues: new Map([
      [2, { type: 'Feature', priority: 'P2', labels: ['area/web'] }],
      [3, { type: 'Bug', priority: 'P0', labels: ['area/session'] }],
    ]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, labels: ['kind/cleanup', 'p2', 'area/web'] }).includes(
      'PR Priority should be p0',
    ),
  )
})

test('requires policy only after a human PR enters review', () => {
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 1,
      reviewCount: 0,
    }),
    true,
  )
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 0,
      reviewCount: 0,
    }),
    false,
  )
})

test('maps only explicit review handoffs to review status commands', () => {
  assert.equal(
    resolvingIssueStatusCommand('pull_request', {
      action: 'review_requested',
    }),
    'review-requested',
  )
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
    }),
    'changes-requested',
  )
  for (const state of ['approved', 'commented']) {
    assert.equal(
      resolvingIssueStatusCommand('pull_request_review', {
        action: 'submitted',
        review: { state },
      }),
      null,
    )
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'dismissed',
      review: { state: 'changes_requested' },
    }),
    null,
  )
})

test('keeps ordinary pull request events as forward-only implementation signals', () => {
  for (const action of ['opened', 'edited', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), 'implementation')
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'review_request_removed' }),
    null,
  )
})

test('toggles automation-owned work on request changes and repeated review request', () => {
  for (const status of ['Inbox', 'Backlog', 'Ready']) {
    assert.equal(nextResolvingIssueStatus(status, 'implementation'), 'In progress')
    assert.equal(nextResolvingIssueStatus(status, 'review-requested'), 'In review')
    assert.equal(nextResolvingIssueStatus(status, 'changes-requested'), 'In progress')
  }
  let status = nextResolvingIssueStatus(
    'In review',
    'changes-requested',
    'hydra-issue-management',
  )
  assert.equal(status, 'In progress')
  status = nextResolvingIssueStatus(status, 'review-requested')
  assert.equal(status, 'In review')
})

test('preserves human review status and terminal Issues', () => {
  assert.equal(nextResolvingIssueStatus('In progress', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested', 'tianyicui'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus('Done', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('No action', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus(null, 'review-requested'), null)
})

test('keeps lifecycle projection independent of PR metadata enforcement', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }

  assert.ok(validatePullRequest(pull).length > 0)
  assert.equal(nextResolvingIssueStatus('Inbox', 'review-requested'), 'In review')
})

test('exempts Draft, Bot, and App PRs', () => {
  const invalid = {
    isDraft: false,
    labels: [],
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
    reviewRequestCount: 1,
    reviewCount: 0,
  }
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'Bot' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'App' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'User', isDraft: true }), [])
  assert.ok(validatePullRequest({ ...invalid, authorType: 'User' }).length > 0)
})

test('requires repository PR labels in the enforcement scope', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [], related: [2] },
    issues: new Map([[2, { priority: null }]]),
  })
  assert.ok(errors.includes('PR must have exactly one allowed kind/*, currently 0'))
  assert.ok(errors.includes('PR must have at least one area/*'))
})

test('accepts exactly the canonical kinds with extensible areas', () => {
  for (const kind of canonicalKinds) {
    assert.deepEqual(validatePullRequest(reviewedPull([kind, 'area/future-domain'])), [], kind)
  }
})

test('rejects multiple, unknown, legacy, and Issue-source PR labels', () => {
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'kind/doc', 'area/web']),
    ).includes('PR must have exactly one allowed kind/*, currently 2'),
  )
  assert.ok(
    validatePullRequest(reviewedPull(['kind/experimental', 'area/web'])).includes(
      'PR has unsupported kind/*: kind/experimental',
    ),
  )
  for (const label of legacyLabels) {
    assert.ok(
      validatePullRequest(reviewedPull(['kind/feature', 'area/web', label])).some((error) =>
        error.startsWith('PR has legacy labels: '),
      ),
      label,
    )
  }
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'area/web', 'source/internal-pr']),
    ).includes('source/* is for Issues only: source/internal-pr'),
  )
})

test('allows missing Priority only when resolving Issues are also unprioritized', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/feature', 'area/web'],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, issues: new Map([[2, { priority: 'P2' }]]) }).includes(
      'PR Priority should be p2',
    ),
  )
  assert.ok(
    validatePullRequest({ ...pull, labels: [...pull.labels, 'p2'] }).includes(
      'A resolving PR with a Priority requires every resolved Issue to have a Priority set',
    ),
  )
})
