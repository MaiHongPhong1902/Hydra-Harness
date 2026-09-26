// @vitest-environment jsdom
// ThemePresenter behavior account: root color-scheme and the palette attribute
// follow active.colorScheme only, token variables replace the previous apply's
// set, theme-color metadata follows the rendered body background, and dispose
// retracts everything the presenter wrote.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeSnapshot } from '@hydra/harness-client-ui-theme/client'
import type { DesktopBrowserTheme } from '@hydra/harness-client-ui-layout/src/client/DesktopBrowserPanel.tsx'
import { DARK_ATTRIBUTE, ThemePresenter } from '@hydra/harness-client-ui-layout/src/client/theme-presenter.ts'

const LIGHT_THEME_COLOR = 'rgb(255, 255, 255)'
const DARK_THEME_COLOR = 'rgb(21, 21, 23)'

function snapshot(colorScheme: 'light' | 'dark', tokens: Record<string, string> = {}): ThemeSnapshot {
  // The presenter must key off colorScheme, not the id — keep them distinct.
  const active = { id: `${colorScheme}-test`, colorScheme, tokens }
  return { preference: colorScheme, active, themes: [active], revision: 1 }
}

function clearThemePresentation(): void {
  document.head.querySelectorAll('meta[name="theme-color"], style[data-theme-presenter-test]').forEach((node) => { node.remove() })
}

function themeColorMeta(): HTMLMetaElement | null {
  return document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
}

function browserThemeSpy(): { setTheme: ReturnType<typeof vi.fn>; setChromeTheme: ReturnType<typeof vi.fn> } {
  const setTheme = vi.fn<(theme: DesktopBrowserTheme | null) => void>()
  const setChromeTheme = vi.fn()
  Object.defineProperty(window, 'hydraDesktop', {
    configurable: true,
    value: { browser: { setBounds: vi.fn(), setTheme }, chrome: { setTheme: setChromeTheme } },
  })
  return { setTheme, setChromeTheme }
}

beforeEach(() => {
  clearThemePresentation()
  document.documentElement.style.removeProperty('color-scheme')
  document.body.removeAttribute(DARK_ATTRIBUTE)
  document.body.removeAttribute('style')
  const style = document.createElement('style')
  style.dataset.themePresenterTest = ''
  style.textContent = `
    body { background-color: ${LIGHT_THEME_COLOR}; }
    body[${DARK_ATTRIBUTE}] { background-color: ${DARK_THEME_COLOR}; }
  `
  document.head.append(style)
})

afterEach(() => {
  clearThemePresentation()
  delete window.hydraDesktop
})

describe('ThemePresenter', () => {
  it('light scheme sets root color-scheme and leaves the dark attribute absent', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('light'))
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(themeColorMeta()?.content).toBe(LIGHT_THEME_COLOR)
  })

  it('dark scheme sets root color-scheme, the attribute, and metadata; switching to light updates one node', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark'))
    const meta = themeColorMeta()
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(true)
    expect(meta?.content).toBe(DARK_THEME_COLOR)
    presenter.apply(snapshot('light'))
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(themeColorMeta()).toBe(meta)
    expect(meta?.content).toBe(LIGHT_THEME_COLOR)
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1)
  })

  it('sends the initial resolved token palette to the desktop browser', () => {
    const { setTheme, setChromeTheme } = browserThemeSpy()
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', {
      '--dsw-specific-sidebar-fill': '#101114',
      '--dsw-alias-interactive-bg-active': '#25272b',
      '--dsw-alias-label-primary': '#f5f6f7',
      '--dsw-alias-label-tertiary': '#a1a5ad',
      '--dsw-alias-interactive-bg-hover': '#30343a',
      '--dsw-alias-border-l1': '#464a52',
      '--dsw-alias-focus-ring': '#6ca7ff',
      '--dsw-alias-label-primary-foreground': '#ffffff',
      '--dsw-alias-bg-base': '#17191d',
    }))
    expect(setTheme).toHaveBeenCalledWith({
      colorScheme: 'dark',
      colors: {
        shell: '#101114',
        tabstrip: '#101114',
        surface: '#25272b',
        text: '#f5f6f7',
        muted: '#a1a5ad',
        hover: '#30343a',
        border: '#464a52',
        accent: '#6ca7ff',
        accentText: '#ffffff',
        omnibox: '#17191d',
        status: '#25272b',
      },
    })
    expect(setChromeTheme).toHaveBeenCalledWith({ color: '#101114', symbolColor: '#f5f6f7' })
  })

  it('refreshes the desktop browser theme on scheme switches', () => {
    const { setTheme } = browserThemeSpy()
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('light', {
      '--dsw-specific-sidebar-fill': '#fafafa',
      '--dsw-alias-label-primary': '#111111',
    }))
    presenter.apply(snapshot('dark', {
      '--dsw-specific-sidebar-fill': '#222222',
      '--dsw-alias-label-primary': '#eeeeee',
    }))
    expect(setTheme).toHaveBeenCalledTimes(2)
    expect(setTheme.mock.calls[1]?.[0]).toMatchObject({
      colorScheme: 'dark',
      colors: { shell: '#222222', tabstrip: '#222222', text: '#eeeeee' },
    })
  })

  it('applies tokens as inline variables and clears the previous set on theme change', () => {
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111', '--dsw-alias-fg': '#eee' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#111')
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('#eee')
    presenter.apply(snapshot('light', { '--dsw-alias-bg': '#fff' }))
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('#fff')
    // The old theme's extra variable is gone, not merged.
    expect(document.body.style.getPropertyValue('--dsw-alias-fg')).toBe('')
  })

  it('dispose removes color-scheme, the attribute, and every applied variable, sparing foreign inline styles', () => {
    const { setTheme } = browserThemeSpy()
    document.body.style.setProperty('--foreign', 'kept')
    const presenter = new ThemePresenter()
    presenter.apply(snapshot('dark', { '--dsw-alias-bg': '#111' }))
    const meta = themeColorMeta()
    presenter.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute(DARK_ATTRIBUTE)).toBe(false)
    expect(document.body.style.getPropertyValue('--dsw-alias-bg')).toBe('')
    expect(document.body.style.getPropertyValue('--foreign')).toBe('kept')
    expect(meta?.isConnected).toBe(false)
    expect(setTheme).toHaveBeenLastCalledWith(null)
  })
})
