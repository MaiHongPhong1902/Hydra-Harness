/**
 * Region-splice coverage for the Cordis catalog generator: a regeneration must
 * replace exactly this generator's region and fail loud on any other marker
 * arrangement rather than overwrite prose or a foreign generator's block.
 */

import { describe, expect, it } from 'vitest'
import { REGION_BEGIN, REGION_END, spliceRegion } from './gen-cordis-catalog.ts'

describe('spliceRegion', () => {
  it('replaces exactly the cordis-surface region', () => {
    const doc = `# T\n\nprose\n\n${REGION_BEGIN}\nold\n${REGION_END}\ntail\n`
    expect(spliceRegion(doc, `${REGION_BEGIN}\nnew\n${REGION_END}`))
      .toBe(`# T\n\nprose\n\n${REGION_BEGIN}\nnew\n${REGION_END}\ntail\n`)
  })

  it('fails loud on a page carrying only some other generator\'s region', () => {
    // Another generator's markers satisfy the generic region grammar but must
    // never be overwritten by THIS generator's splice.
    const foreign = '# T\n\n<!-- BEGIN GENERATED other-surface (other-gen.ts) — do not edit between markers -->\ntheirs\n<!-- END GENERATED other-surface -->\n'
    expect(() => spliceRegion(foreign, `${REGION_BEGIN}\nnew\n${REGION_END}`))
      .toThrow('expected exactly 1 cordis-surface region, found 0 BEGIN/0 END')
  })

  it('fails loud on duplicate cordis-surface markers', () => {
    const doubled = `${REGION_BEGIN}\na\n${REGION_END}\n${REGION_BEGIN}\nb\n${REGION_END}\n`
    expect(() => spliceRegion(doubled, `${REGION_BEGIN}\nnew\n${REGION_END}`))
      .toThrow('found 2 BEGIN/2 END')
  })
})
