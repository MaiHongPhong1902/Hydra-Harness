// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import * as primitives from '@hydra1902/harness-client-ui-primitives'
import {
  IconApiOutline14, IconArchiveOutline20, IconFolderClose16, IconGoalOutline16, IconSendOutline16,
} from '@hydra1902/harness-client-ui-primitives'
import { hydraHoverData } from '../src/hydra-hover-data.ts'
import { hydraLogoData } from '../src/hydra-logo-data.ts'

afterEach(cleanup)

// Icon components all share the IconProps signature; the barrel also exports
// non-icon atoms (different props shapes), so filter by prefix BEFORE typing.
const icons = Object.fromEntries(
  Object.entries(primitives).filter(([name]) => name.startsWith('Icon')),
) as Record<string, (p: primitives.IconProps) => React.JSX.Element>
const iconNames = Object.keys(icons)

describe('ic_ds_ icon set', () => {
  it('exports the full icon set (46 deepsuite + 20 figma extracts + five product glyphs outside those sets)', () => {
    expect(iconNames.length).toBe(71)
  })

  it.each(iconNames)('%s renders an svg with currentColor fills and no hardcoded palette', (name) => {
    const Icon = icons[name]!
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    const markup = container.innerHTML
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}"/)
    expect(markup).toContain('currentColor')
  })

  it('size and className props land on the root svg', () => {
    const { container } = render(<IconSendOutline16 size={20} className="x" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.classList.contains('x')).toBe(true)
  })

  it('each glyph defaults to its own drawn size, not one set-wide default', () => {
    const api = render(<IconApiOutline14 />)
    expect(api.container.querySelector('svg')!.getAttribute('width')).toBe('14')
    const folder = render(<IconFolderClose16 />)
    expect(folder.container.querySelector('svg')!.getAttribute('width')).toBe('16')
    const archive = render(<IconArchiveOutline20 />)
    expect(archive.container.querySelector('svg')!.getAttribute('width')).toBe('20')
  })

  it('renders reusable goal glyphs without document-global ids', () => {
    const { container } = render(<><IconGoalOutline16 /><IconGoalOutline16 /></>)
    expect(container.querySelector('[id]')).toBeNull()
    expect(container.querySelector('[clip-path]')).toBeNull()
  })
})

describe('HydraLogo', () => {
  it('mounts the supplied animation on hover and restores the still logo on leave', () => {
    const { container } = render(<primitives.HydraLogo />)
    const svg = container.querySelector('svg')!
    const still = container.querySelector('image')!.getAttribute('href')
    expect(container.querySelectorAll('image')).toHaveLength(1)
    fireEvent.mouseEnter(svg)
    const animation = container.querySelectorAll('image')[1]!
    expect(animation.getAttribute('href')).toBe(hydraHoverData)
    fireEvent.mouseLeave(svg)
    expect(animation.isConnected).toBe(false)
    expect(container.querySelector('image')!.getAttribute('href')).toBe(still)
  })

  it('renders the supplied Hydra mark at the requested square size', () => {
    const { container } = render(<primitives.HydraLogo />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(svg.getAttribute('height')).toBe('24')
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256')
    const png = readFileSync(resolve(import.meta.dirname, '../src/hydra-logo.png'))
    expect(container.querySelector('image')!.getAttribute('href')).toBe(hydraLogoData)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(256)
    expect(png.readUInt32BE(20)).toBe(256)
  })
})

describe('BrandWordmark', () => {
  it('can render the name artwork with or without its leading mark', () => {
    const view = render(<primitives.BrandWordmark />)
    const svg = view.container.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('182')
    expect(svg.getAttribute('viewBox')).toBe('0 0 182 24')
    expect(svg.textContent).toBe('Hydra harness')
    expect(view.container.querySelector('svg[viewBox="0 0 256 256"]')).not.toBeNull()

    view.rerender(<primitives.BrandWordmark includeMark={false} />)
    expect(svg.getAttribute('width')).toBe('156')
    expect(svg.getAttribute('viewBox')).toBe('26 0 156 24')
    expect(view.container.querySelector('svg[viewBox="0 0 256 256"]')).toBeNull()
  })
})
