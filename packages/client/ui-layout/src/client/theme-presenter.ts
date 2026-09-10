/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, and one
 * presenter-owned `meta[name="theme-color"]` for surrounding browser UI.
 * Embedded browser chrome receives the same resolved scheme and CSS colors. Pure
 * DOM writes, no React involvement; the presenter only ever retracts what it
 * wrote itself, so foreign attributes, metadata, and inline styles survive.
 */
import type { ThemeSnapshot } from '@hydra/harness-client-ui-theme/client'
import type { DesktopBrowserTheme } from './DesktopBrowserPanel.tsx'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  private appliedTokens: string[] = []
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), then replace the previously applied token variables
   * with `active.tokens`. Browser theme-color metadata follows the computed
   * body background after those writes; embedded browser chrome receives the
   * computed token colors, so the rendered palette remains the color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    const style = getComputedStyle(body)
    const value = (name: string): string => style.getPropertyValue(name).trim()
    const browserTheme: DesktopBrowserTheme = {
      colorScheme: scheme,
      colors: {
        shell: value('--dsw-specific-sidebar-fill'),
        tabstrip: value('--dsw-specific-sidebar-fill'),
        surface: value('--dsw-alias-interactive-bg-active'),
        text: value('--dsw-alias-label-primary'),
        muted: value('--dsw-alias-label-tertiary'),
        hover: value('--dsw-alias-interactive-bg-hover'),
        border: value('--dsw-alias-border-l1'),
        accent: value('--dsw-alias-focus-ring'),
        accentText: value('--dsw-alias-label-primary-foreground'),
        omnibox: value('--dsw-alias-bg-base'),
        status: value('--dsw-alias-interactive-bg-active'),
      },
    }
    window.hydraDesktop?.browser.setTheme?.(browserTheme)
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /** Retract owned DOM theme values and return native browser chrome to its OS palette. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    window.hydraDesktop?.browser.setTheme?.(null)
    this.themeColorMeta.remove()
  }
}
