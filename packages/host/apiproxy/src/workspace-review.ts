/** Read-only Git comparisons restricted to the session cwd, with bounded output and cancellation. @module */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ReviewHunk, ReviewMode, WorkspaceReview, WorkspaceReviewFile } from '@hydra1902/harness-fs-review/client'

const execute = promisify(execFile)
/** Deployment budgets shared by the gateway's config and its direct constructor. */
export interface ReviewLimits {
  reviewMaxBytes: number
  reviewMaxFiles: number
  reviewTimeoutMs: number
}

/**
 * Resolve and validate live Git review budgets.
 * @param options - deployment overrides.
 * @returns positive integer budgets.
 */
export function resolveReviewLimits(options: Partial<ReviewLimits>): ReviewLimits {
  const limits = {
    reviewMaxBytes: options.reviewMaxBytes ?? 4 * 1024 * 1024,
    reviewMaxFiles: options.reviewMaxFiles ?? 500,
    reviewTimeoutMs: options.reviewTimeoutMs ?? 15000,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  }
  return limits
}

function contained(root: string, path: string): boolean {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../')
}

function parsePatch(path: string, status: WorkspaceReviewFile['status'], patch: string): WorkspaceReviewFile {
  const hunks: ReviewHunk[] = []
  let current: ReviewHunk | undefined
  let additions = 0
  let deletions = 0
  for (const line of patch.replace(/\n$/u, '').split('\n')) {
    if (line.startsWith('@@ ')) {
      current = { header: line, lines: [] }
      hunks.push(current)
    } else if (current !== undefined && /^[+ \\-]/u.test(line)) {
      current.lines.push(line)
      if (line.startsWith('+')) additions++
      if (line.startsWith('-')) deletions++
    }
  }
  const binary = /^Binary files |^GIT binary patch/mu.test(patch)
  return { path, status, hunks, additions, deletions, binary, truncated: false, patch: binary ? null : patch }
}

function parseGitDiff(output: string, maxFiles: number): { files: WorkspaceReviewFile[]; truncated: boolean } {
  if (output === '') return { files: [], truncated: false }
  const boundary = output.indexOf('\0\0')
  if (boundary < 0) throw new Error('Git returned an unsupported diff format')
  const metadata = output.slice(0, boundary).split('\0')
  const chunks = output.slice(boundary + 2).split(/^diff --git /mu).slice(1)
  const files: WorkspaceReviewFile[] = []
  if (metadata.length !== chunks.length * 2) throw new Error('Resolve merge conflicts before reviewing this comparison')
  for (let index = 0; index < Math.min(chunks.length, maxFiles); index++) {
    /* v8 ignore next -- Metadata length is checked against twice the chunk count before indexing. @preserve */
    const record = metadata[index * 2] ?? ''
    /* v8 ignore next -- Metadata length is checked against twice the chunk count before indexing. @preserve */
    const path = metadata[index * 2 + 1] ?? ''
    const kind = record.slice(-1)
    files.push(parsePatch(path, kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified', `diff --git ${(
      /* v8 ignore start -- index is bounded by the dense chunks array length. */
      chunks[index] ?? ''
      /* v8 ignore stop */
    )}`))
  }
  return { files, truncated: chunks.length > maxFiles }
}

async function addedFile(cwd: string, path: string, maxBytes: number): Promise<WorkspaceReviewFile> {
  const empty: WorkspaceReviewFile = { path, status: 'added', additions: 0, deletions: 0, hunks: [], binary: false, truncated: false, patch: null }
  const target = resolve(cwd, path)
  if (!contained(cwd, target)) throw new Error('Git returned a file outside the session workspace')
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink()) return { ...empty, binary: true }
  if (info.size > maxBytes) return { ...empty, truncated: true }
  if (!contained(cwd, await realpath(target))) throw new Error('Review file resolves outside the session workspace')
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    if (!(await handle.stat()).isFile()) return { ...empty, binary: true }
    bytes = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > maxBytes) return { ...empty, truncated: true }
    bytes = bytes.subarray(0, bytesRead)
  } finally { await handle.close() }
  if (bytes.includes(0)) return { ...empty, binary: true }
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch (_invalidUtf8) { return { ...empty, binary: true } }
  const lines = content === '' ? [] : content.replace(/\n$/u, '').split('\n')
  const mode = (info.mode & 0o111) === 0 ? '100644' : '100755'
  const before = JSON.stringify(`a/${path}`)
  const after = JSON.stringify(`b/${path}`)
  const hunk = lines.length === 0 ? '' : `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`
  return parsePatch(path, 'added', `diff --git ${before} ${after}\nnew file mode ${mode}\n--- /dev/null\n+++ ${after}\n${hunk}`)
}

/**
 * Read a local Git comparison without acquiring an agent or changing the index/worktree.
 * A branch comparison without a ref uses the current branch's upstream; detached HEAD requires an explicit ref.
 * @param cwd - recorded session workspace; never a client-supplied path.
 * @param request - comparison and optional branch/commit, resolved to an object id before use.
 * @param limits - deployment output/file/time budgets.
 * @param signal - carrier cancellation; all child processes observe it.
 * @returns real workspace metadata and bounded diff evidence; a plain folder has repository=null.
 */
export async function readWorkspaceReview(
  cwd: string, request: { mode: ReviewMode; ref?: string; fullContext?: boolean }, limits: ReviewLimits, signal?: AbortSignal,
): Promise<WorkspaceReview> {
  const workspace = await realpath(cwd)
  const abort = AbortSignal.any([AbortSignal.timeout(limits.reviewTimeoutMs), ...(signal === undefined ? [] : [signal])])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^GIT_/iu.test(key)))
  const git = async (args: string[], allowedCode?: number): Promise<string> => {
    abort.throwIfAborted()
    const pending = execute('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', workspace, ...args], {
      encoding: 'utf8', env, windowsHide: true, maxBuffer: limits.reviewMaxBytes, signal: abort,
    })
    // execFile can reject on abort before the child releases its working directory.
    const closed = new Promise<void>(resolve => pending.child.once('close', () => { resolve() }))
    try {
      const { stdout } = await pending
      return stdout
    } catch (error: unknown) {
      abort.throwIfAborted()
      const failure = error as { code?: unknown; stderr?: string }
      if (allowedCode !== undefined && failure.code === allowedCode) return ''
      if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Diff exceeds the configured review byte limit')
      if (failure.code === 'ENOENT') throw new Error('Git is not installed on the session host')
      if (failure.stderr?.includes('not a git repository')) return ''
      throw new Error(`Git could not read this comparison (${String(failure.code)}). Check the selected reference and repository access.`)
    } finally {
      await closed
    }
  }
  const repository = (await git(['rev-parse', '--show-toplevel'])).trim() || null
  const result: WorkspaceReview = {
    workspace, repository, branch: null, branches: [], commits: [], mode: request.mode, baseRef: null, files: [], truncated: false,
  }
  const boundedResult = (): WorkspaceReview => {
    if (Buffer.byteLength(JSON.stringify(result)) > limits.reviewMaxBytes) {
      throw new Error('Diff exceeds the configured review byte limit')
    }
    return result
  }
  if (repository === null) return boundedResult()
  result.branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 1)).trim() || null
  result.branches = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).trim().split('\n').filter(Boolean)
  const head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], 1)).trim()
  if (head !== '') {
    result.commits = (await git(['log', '-n', String(Math.min(limits.reviewMaxFiles, 50)), '--format=%H%x09%s', '--', '.'])).trim().split('\n').filter(Boolean).map(line => ({ oid: line.slice(0, line.indexOf('\t')), subject: line.slice(line.indexOf('\t') + 1) }))
  }
  const resolveRef = async (ref: string): Promise<string> => {
    if (ref.startsWith('-') || /[\u0000-\u001f]/u.test(ref)) throw new Error('Invalid review reference')
    return (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim()
  }
  let command = ['diff']
  if (request.mode === 'committed') {
    if (head === '') throw new Error('This repository has no commits to review')
    const commit = await resolveRef(request.ref ?? head)
    result.baseRef = request.ref ?? commit
    const parents = (await git(['rev-list', '--parents', '-n', '1', commit])).trim().split(' ')
    command = parents[1] === undefined ? ['diff-tree', '--root', '--no-commit-id', '-r', commit] : ['diff', parents[1], commit]
  } else if (request.mode === 'branch') {
    if (head === '') throw new Error('This repository has no commits to compare')
    const reference = request.ref ?? (result.branch === null ? ''
      : (await git(['for-each-ref', '--format=%(upstream)', `refs/heads/${result.branch}`])).trim())
    if (reference === '') throw new Error('Select a base branch for this comparison')
    const base = await resolveRef(reference)
    const mergeBase = (await git(['merge-base', base, head])).trim()
    result.baseRef = reference
    command.push(mergeBase, head)
  } else if (request.mode === 'staged') command.push('--cached')
  else if (request.mode === 'uncommitted' && head !== '') command.push(head)
  const unbornCurrent = request.mode === 'uncommitted' && head === ''
  if (!unbornCurrent) {
    const output = await git([...command, '--relative', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--raw', '-z', '--patch', `--unified=${request.fullContext === true ? limits.reviewMaxBytes : 3}`, '--', '.'])
    const parsed = parseGitDiff(output, limits.reviewMaxFiles)
    result.files = parsed.files
    result.truncated = parsed.truncated
  }
  if (request.mode === 'uncommitted' || request.mode === 'unstaged') {
    const paths = (await git(['ls-files', '--others', '--exclude-standard', ...(unbornCurrent ? ['--cached'] : []), '-z', '--', '.'])).split('\0').filter(Boolean)
    const remaining = limits.reviewMaxFiles - result.files.length
    let bytesLeft = limits.reviewMaxBytes - result.files.reduce((total, file) => total + Buffer.byteLength(file.patch ?? ''), 0)
    for (const path of [...new Set(paths)].slice(0, remaining)) {
      abort.throwIfAborted()
      const file = await addedFile(workspace, path, Math.max(0, bytesLeft))
      result.files.push(file)
      bytesLeft -= Buffer.byteLength(file.patch ?? '')
    }
    result.truncated ||= paths.length > remaining
  }
  return boundedResult()
}
