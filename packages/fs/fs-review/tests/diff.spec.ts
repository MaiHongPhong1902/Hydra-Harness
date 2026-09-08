import { describe, expect, it } from 'vitest'
import { preview, type ReviewLimits } from '../src/diff.ts'

const limits: ReviewLimits = { snapshotMaxBytes: 1024, diffMaxBytes: 64, diffMaxLines: 4, diffMaxCells: 25 }
const bytes = (text: string) => Buffer.from(text)

describe('stored bounded previews', () => {
  it('normalizes CRLF and retains context and missing-final-newline evidence', () => {
    const result = preview(bytes('same\r\nold'), bytes('same\nnew'), limits)
    expect(result).toMatchObject({ binary: false, truncated: false, additions: 1, deletions: 1 })
    expect(result.hunks[0]?.lines).toEqual([' same', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'])
    expect(preview(bytes(''), bytes(''), limits).hunks).toEqual([])
  })

  it.each([
    [null, bytes('a')], [bytes('a'), null],
    [bytes('a'.repeat(65)), bytes('a')], [bytes('a'), bytes('a'.repeat(65))],
    [bytes('1\n2\n3\n4\n5'), bytes('a')], [bytes('a'), bytes('1\n2\n3\n4\n5')],
  ])('omits unavailable or over-limit sides', (before, after) => {
    expect(preview(before, after, limits)).toEqual({ binary: false, truncated: true, additions: 0, deletions: 0, hunks: [] })
  })

  it('accepts exact byte/line/cell limits and rejects excessive comparison work', () => {
    expect(preview(bytes('a'.repeat(64)), bytes('b'.repeat(64)), limits).truncated).toBe(false)
    const four = bytes('1\n2\n3\n4\n')
    expect(preview(four, four, limits).truncated).toBe(false)
    expect(preview(four, four, { ...limits, diffMaxCells: 24 }).truncated).toBe(true)
  })

  it.each([[bytes('\0'), bytes('a')], [bytes('a'), bytes('\0')], [Buffer.from([255]), bytes('a')], [bytes('a'), Buffer.from([255])]])('marks NUL and invalid UTF-8 as binary', (before, after) => {
    expect(preview(before, after, limits)).toEqual({ binary: true, truncated: false, additions: 0, deletions: 0, hunks: [] })
  })
})
