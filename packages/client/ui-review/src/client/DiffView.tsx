/** Render durable review hunks in unified or paired side-by-side form. @module */
import type { ReactNode } from 'react'
import type { ReviewHunk } from '@hydraharness/harness-fs-review/client'
import css from './DiffView.module.css'

type DiffMode = 'unified' | 'split'
type LineKind = 'context' | 'add' | 'del'

interface DiffViewProps {
  /** Stored hunks in file order; this component never mutates them. */
  hunks: readonly ReviewHunk[]
  /** Relative workspace path used for the accessible label and data identity. */
  path: string
  /** The unified stream or paired old/new layout. */
  mode: DiffMode
  /** Allow source lines to wrap inside their cells. */
  wordWrap: boolean
  /** Highlight the changed portion of paired lines. */
  wordDiffs: boolean
  /** Hide whitespace-only replacements and trailing horizontal whitespace. */
  hideWhitespace: boolean
}

interface DiffLine {
  kind: LineKind
  raw: string
  content: string
  oldLine: number | null
  newLine: number | null
  markers: string[]
}

interface DiffModel {
  lines: DiffLine[]
  pairs: Map<DiffLine, DiffLine>
}

interface SplitRow {
  oldLine: DiffLine | null
  newLine: DiffLine | null
  markers: string[]
}

function hunkStarts(header: string): { oldStart: number; newStart: number } {
  const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(header)
  return {
    oldStart: match?.[1] === undefined ? 1 : Number(match[1]),
    newStart: match?.[2] === undefined ? 1 : Number(match[2]),
  }
}

function parseHunk(hunk: ReviewHunk): DiffLine[] {
  const starts = hunkStarts(hunk.header)
  let oldLine = starts.oldStart
  let newLine = starts.newStart
  const lines: DiffLine[] = []
  for (const raw of hunk.lines) {
    if (raw.startsWith('\\')) {
      const previous = lines.at(-1)
      if (previous !== undefined) previous.markers.push(raw)
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', raw, content: raw.slice(1), oldLine: null, newLine: newLine++, markers: [] })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', raw, content: raw.slice(1), oldLine: oldLine++, newLine: null, markers: [] })
    } else {
      lines.push({ kind: 'context', raw, content: raw.startsWith(' ') ? raw.slice(1) : raw, oldLine: oldLine++, newLine: newLine++, markers: [] })
    }
  }
  return lines
}

function comparable(value: string): string {
  return value.replace(/\s+/gu, '')
}

/** Drop only paired whitespace changes, leaving real changed lines untouched. */
function hideWhitespaceLines(lines: DiffLine[], enabled: boolean): DiffLine[] {
  if (!enabled) return lines
  const output: DiffLine[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined || line.kind === 'context') {
      /* v8 ignore next -- The dense parsed lines array is indexed below its length. @preserve */
      if (line !== undefined) output.push(line)
      index++
      continue
    }
    const run: DiffLine[] = []
    while (index < lines.length && lines[index]?.kind !== 'context') {
      const candidate = lines[index]
      /* v8 ignore next -- The dense parsed lines array is indexed below its length. @preserve */
      if (candidate !== undefined) run.push(candidate)
      index++
    }
    const additions = run.filter(candidate => candidate.kind === 'add')
    const deletions = run.filter(candidate => candidate.kind === 'del')
    const hidden = new Set<DiffLine>()
    for (const [pairIndex, deletion] of deletions.entries()) {
      const addition = additions[pairIndex]
      if (addition !== undefined && comparable(deletion.content) === comparable(addition.content)) {
        hidden.add(deletion)
        hidden.add(addition)
      }
    }
    for (const candidate of run) {
      if (!hidden.has(candidate)) output.push(candidate)
    }
  }
  return output
}

function pairLines(lines: DiffLine[]): Map<DiffLine, DiffLine> {
  const pairs = new Map<DiffLine, DiffLine>()
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    /* v8 ignore next -- The dense parsed lines array is indexed below its length. @preserve */
    if (line === undefined) break
    if (line.kind === 'context') {
      index++
      continue
    }
    const deletions: DiffLine[] = []
    const additions: DiffLine[] = []
    while (index < lines.length && lines[index]?.kind !== 'context') {
      const candidate = lines[index]
      if (candidate?.kind === 'del') deletions.push(candidate)
      if (candidate?.kind === 'add') additions.push(candidate)
      index++
    }
    for (let pairIndex = 0; pairIndex < Math.min(deletions.length, additions.length); pairIndex++) {
      const deletion = deletions[pairIndex]
      const addition = additions[pairIndex]
      /* v8 ignore next -- pairIndex is smaller than both dense array lengths. @preserve */
      if (deletion !== undefined && addition !== undefined) {
        pairs.set(deletion, addition)
        pairs.set(addition, deletion)
      }
    }
  }
  return pairs
}

function modelFor(hunk: ReviewHunk, hideWhitespace: boolean): DiffModel {
  const lines = hideWhitespaceLines(parseHunk(hunk), hideWhitespace)
  return { lines, pairs: pairLines(lines) }
}

function shown(value: string, hideWhitespace: boolean): string {
  return hideWhitespace ? value.replace(/[ \t]+$/u, '') : value
}

function splitChange(value: string, other: string): [string, string, string] {
  const left = Array.from(value)
  const right = Array.from(other)
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++
  return [
    left.slice(0, prefix).join(''),
    left.slice(prefix, left.length - suffix).join(''),
    left.slice(left.length - suffix).join(''),
  ]
}

function lineClass(line: DiffLine): string {
  /* v8 ignore next -- The imported CSS module declares a class for every LineKind. @preserve */
  return (line.kind === 'add' ? css.add : line.kind === 'del' ? css.del : css.context) ?? ''
}

function lineNumber(value: number | null, className: string): ReactNode {
  return <span className={`${(
    /* v8 ignore start -- The imported CSS module declares this class. */
    css.lineNumber ?? ''
    /* v8 ignore stop */
  )} ${className}`} data-line={value === null ? '' : value} aria-hidden="true" />
}

function lineText(line: DiffLine, pair: DiffLine | undefined, props: DiffViewProps): ReactNode {
  const value = shown(line.content, props.hideWhitespace)
  const other = pair === undefined ? undefined : shown(pair.content, props.hideWhitespace)
  if (!props.wordDiffs || other === undefined || value === other) return value
  const [prefix, changed, suffix] = splitChange(value, other)
  return changed === '' ? value : <>{prefix}<mark className={(
    /* v8 ignore start -- The imported CSS module declares this class. */
    css.wordChange ?? ''
    /* v8 ignore stop */
  )} data-word-diff="">{changed}</mark>{suffix}</>
}

function renderUnifiedLine(line: DiffLine, pair: DiffLine | undefined, props: DiffViewProps, key: string): ReactNode[] {
  const prefix = line.kind === 'context'
    ? (line.raw.startsWith(' ') ? ' ' : '')
    : line.raw.charAt(0)
  const lineNode = (
    <span
      className={`${(
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.unifiedLine ?? ''
        /* v8 ignore stop */
      )} ${lineClass(line)}`}
      data-diff-line=""
      data-kind={line.kind}
      data-old-line={line.oldLine === null ? '' : line.oldLine}
      data-new-line={line.newLine === null ? '' : line.newLine}
      key={key}
    >
      {lineNumber(line.oldLine, (
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.oldNumber ?? ''
        /* v8 ignore stop */
      ))}
      {lineNumber(line.newLine, (
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.newNumber ?? ''
        /* v8 ignore stop */
      ))}
      <span className={(
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.lineText ?? ''
        /* v8 ignore stop */
      )}>{prefix}{lineText(line, pair, props)}</span>
    </span>
  )
  return [lineNode, ...line.markers.map((marker, index) => (
    <span className={(
      /* v8 ignore start -- The imported CSS module declares this class. */
      css.markerRow ?? ''
      /* v8 ignore stop */
    )} data-no-newline="" key={`${key}-marker-${index}`}>{marker}</span>
  ))]
}

/* jscpd:ignore-start -- unified and split renderers intentionally share diff-run pairing. */
function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    /* v8 ignore next -- The dense parsed lines array is indexed below its length. @preserve */
    if (line === undefined) break
    if (line.kind === 'context') {
      rows.push({ oldLine: line, newLine: line, markers: line.markers })
      index++
      continue
    }
    const deletions: DiffLine[] = []
    const additions: DiffLine[] = []
    while (index < lines.length && lines[index]?.kind !== 'context') {
      const candidate = lines[index]
      if (candidate?.kind === 'del') deletions.push(candidate)
      if (candidate?.kind === 'add') additions.push(candidate)
      index++
    }
    const count = Math.max(deletions.length, additions.length)
    for (let pairIndex = 0; pairIndex < count; pairIndex++) {
      const oldLine = deletions[pairIndex] ?? null
      const newLine = additions[pairIndex] ?? null
      rows.push({ oldLine, newLine, markers: [...(oldLine?.markers ?? []), ...(newLine?.markers ?? [])] })
    }
  }
  return rows
}
/* jscpd:ignore-end */

function renderSide(line: DiffLine | null, side: 'old' | 'new', pair: DiffLine | undefined, props: DiffViewProps): ReactNode {
  if (line === null) return <span className={`${(
    /* v8 ignore start -- The imported CSS module declares this class. */
    css.sideCell ?? ''
    /* v8 ignore stop */
  )} ${(
    /* v8 ignore start -- The imported CSS module declares this class. */
    css.emptySide ?? ''
    /* v8 ignore stop */
  )}`} data-side={side} aria-hidden="true" />
  const number = side === 'old' ? line.oldLine : line.newLine
  const prefix = line.kind === 'context'
    ? (line.raw.startsWith(' ') ? ' ' : '')
    : line.raw.charAt(0)
  return (
    <span className={`${(
      /* v8 ignore start -- The imported CSS module declares this class. */
      css.sideCell ?? ''
      /* v8 ignore stop */
    )} ${lineClass(line)}`} data-side={side} data-kind={line.kind} data-old-line={line.oldLine === null ? '' : line.oldLine} data-new-line={line.newLine === null ? '' : line.newLine}>
      {lineNumber(number, (
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.sideNumber ?? ''
        /* v8 ignore stop */
      ))}
      <span className={(
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.sideText ?? ''
        /* v8 ignore stop */
      )}>{prefix}{lineText(line, pair, props)}</span>
    </span>
  )
}

function renderSplitRow(row: SplitRow, pairs: Map<DiffLine, DiffLine>, props: DiffViewProps, key: string): ReactNode[] {
  const oldPair = row.oldLine === null ? undefined : pairs.get(row.oldLine)
  const newPair = row.newLine === null ? undefined : pairs.get(row.newLine)
  const rowNode = (
    <span className={(
      /* v8 ignore start -- The imported CSS module declares this class. */
      css.splitRow ?? ''
      /* v8 ignore stop */
    )} data-diff-line="" key={key}>
      {renderSide(row.oldLine, 'old', oldPair, props)}
      {renderSide(row.newLine, 'new', newPair, props)}
    </span>
  )
  return [rowNode, ...row.markers.map((marker, index) => (
    <span className={(
      /* v8 ignore start -- The imported CSS module declares this class. */
      css.splitMarker ?? ''
      /* v8 ignore stop */
    )} data-no-newline="" key={`${key}-marker-${index}`}>{marker}</span>
  ))]
}

function joinRows(rows: ReactNode[]): ReactNode[] {
  return rows.flatMap((row, index) => index === 0 ? [row] : ['\n', row])
}

/** Render recorded review hunks without coupling Review rows to diff layout. */
export function DiffView({ hunks, path, mode, wordWrap, wordDiffs, hideWhitespace }: DiffViewProps) {
  const options = { hunks, path, mode, wordWrap, wordDiffs, hideWhitespace }
  const rows: ReactNode[] = []
  hunks.forEach((hunk, hunkIndex) => {
    const model = modelFor(hunk, hideWhitespace)
    const hunkRows: ReactNode[] = [<span className={(
      /* v8 ignore start -- The imported CSS module declares this class. */
      css.hunkHeader ?? ''
      /* v8 ignore stop */
    )} key={`hunk-${hunkIndex}`}>{hunk.header}</span>]
    if (mode === 'unified') {
      for (const [lineIndex, line] of model.lines.entries()) hunkRows.push(...renderUnifiedLine(line, model.pairs.get(line), options, `line-${hunkIndex}-${lineIndex}`))
    } else {
      splitRows(model.lines).forEach((row, rowIndex) => hunkRows.push(...renderSplitRow(row, model.pairs, options, `split-${hunkIndex}-${rowIndex}`)))
    }
    rows.push(...hunkRows)
  })
  return (
    <div className={`${(
      /* v8 ignore start -- The imported CSS module declares this class. */
      css.view ?? ''
      /* v8 ignore stop */
    )} ${mode === 'split' ? (
    /* v8 ignore start -- The imported CSS module declares this class. */
      css.split ?? ''
    /* v8 ignore stop */
    ) : (
    /* v8 ignore start -- The imported CSS module declares this class. */
      css.unified ?? ''
    /* v8 ignore stop */
    )} ${wordWrap ? (
    /* v8 ignore start -- The imported CSS module declares this class. */
      css.wordWrap ?? ''
    /* v8 ignore stop */
    ) : ''}`} data-diff-view="" data-mode={mode} data-path={path} role="region" aria-label={`Recorded diff for ${path}`}>
      <pre className={(
        /* v8 ignore start -- The imported CSS module declares this class. */
        css.body ?? ''
        /* v8 ignore stop */
      )}>{joinRows(rows)}</pre>
    </div>
  )
}
