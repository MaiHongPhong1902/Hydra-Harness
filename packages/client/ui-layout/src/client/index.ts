/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * four child slots (declaration = exclusive render authority), seats the
 * layout store (panel geometry), and wires the panel-action service face.
 * ctx.layout is the cross-plugin panel-action contract; navigation state lives
 * with the runtime sessions service. A second effect seats the theme
 * presenter, which projects ctx.theme snapshots onto document.body. The same
 * desktop feature owner contributes Browser settings when its preload exists.
 */
import type { ClientContext } from '@hydra/harness-client-runtime/client'
import type {} from '@hydra/harness-client-ui-theme/client'
import type {} from '@hydra/harness-client-ui-settings/client'
import type {} from '@hydra/harness-client-locale/client'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { BrowserSection, BROWSER_SETTINGS_NAMESPACE } from './BrowserSection.tsx'
import type { BrowserSectionInjected, BrowserSettings } from './BrowserSection.tsx'
import { en as browserEn } from './browser-locales.ts'
import type { BrowserKey } from './browser-locales.ts'
import type { DesktopBrowserApi } from './DesktopBrowserPanel.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'

type BrowserManagementApi = DesktopBrowserApi & Required<Pick<
  DesktopBrowserApi,
  'configure' | 'clearData' | 'history' | 'removeHistory' | 'downloads'
  | 'removeDownload' | 'sites' | 'setSite' | 'removeSite'
>>

type AutofillManagementApi = DesktopBrowserApi & Required<Pick<
  DesktopBrowserApi,
  'autofillStatus' | 'autofillListLogins' | 'autofillSaveLogin' | 'autofillRemoveLogin'
  | 'autofillListContacts' | 'autofillGetContact' | 'autofillSaveContact' | 'autofillRemoveContact'
>>

function hasBrowserManagement(browser: DesktopBrowserApi | undefined): browser is BrowserManagementApi {
  return browser !== undefined
    && typeof browser.configure === 'function'
    && typeof browser.clearData === 'function'
    && typeof browser.history === 'function'
    && typeof browser.removeHistory === 'function'
    && typeof browser.downloads === 'function'
    && typeof browser.removeDownload === 'function'
    && typeof browser.sites === 'function'
    && typeof browser.setSite === 'function'
    && typeof browser.removeSite === 'function'
}

function hasAutofillManagement(browser: DesktopBrowserApi): browser is AutofillManagementApi {
  return typeof browser.autofillStatus === 'function'
    && typeof browser.autofillListLogins === 'function'
    && typeof browser.autofillSaveLogin === 'function'
    && typeof browser.autofillRemoveLogin === 'function'
    && typeof browser.autofillListContacts === 'function'
    && typeof browser.autofillGetContact === 'function'
    && typeof browser.autofillSaveContact === 'function'
    && typeof browser.autofillRemoveContact === 'function'
}

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@hydra/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@hydra/harness-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop Browser settings copy. */
    'settings.browser': BrowserKey
  }

  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. OCCUPIED by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it —
     * registering here replaces the entire conversation surface (and removes
     * every seat it declares) rather than adding to it.
     *
     * Current-session-optional: the occupant owns both states without
     * changing its React identity, so it keeps its own state across a session
     * switch. It receives no owner props; session facts arrive through the
     * framework hooks of the `session-maybe` scope.
     */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /**
     * The right details column, shown when the layout opens it. OCCUPIED by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it — registering here replaces the column and takes that seat
     * with it. Absent an occupant the column renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, and `ctx.layout` owns whether the column is open.
     */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: secondary occurrences suppress global navigation chrome. */
export interface ConvOwnerProps {
  secondary?: boolean | undefined
}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'sessions', 'workspaces', 'locale', 'settingsScope']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const desktop = globalThis as typeof globalThis & { bhDesktop?: { browser?: DesktopBrowserApi } }
  const browser = desktop.bhDesktop?.browser
  if (hasBrowserManagement(browser)) {
    const autofill = hasAutofillManagement(browser) ? browser : undefined
    const openUrl = browser.openUrl === undefined ? undefined : async (url: string) => {
      await browser.openUrl?.(url)
    }
    const autofillUnavailable = () => Promise.reject(new Error('secure autofill storage is unavailable'))
    ctx.effect(
      () => ctx.locale.register('settings.browser', { en: browserEn }),
      'ui-layout: Browser settings dictionaries',
    )
    const t = ctx.locale.bind('settings.browser')
    const scope = ctx.settingsScope.bind<BrowserSettings>({ namespace: BROWSER_SETTINGS_NAMESPACE })
    const injected = (): BrowserSectionInjected => ({
      setSetting: (key, value) => scope.set(key, value),
      configureNative: settings => browser.configure(settings),
      pickDownloadDirectory: () => ctx.workspaces.pickDirectory(),
      clearData: scope => browser.clearData(scope),
      ...(openUrl === undefined ? {} : { openUrl: (url: string) => openUrl(url) }),
      history: () => browser.history(),
      removeHistory: id => browser.removeHistory(id),
      downloads: () => browser.downloads(),
      removeDownload: id => browser.removeDownload(id),
      sites: () => browser.sites(),
      setSite: site => browser.setSite(site),
      removeSite: origin => browser.removeSite(origin),
      autofillStatus: () => autofill?.autofillStatus() ?? Promise.resolve({ available: false }),
      logins: () => autofill?.autofillListLogins() ?? autofillUnavailable(),
      saveLogin: login => autofill?.autofillSaveLogin(login) ?? autofillUnavailable(),
      removeLogin: id => autofill?.autofillRemoveLogin(id) ?? autofillUnavailable(),
      contacts: () => autofill?.autofillListContacts() ?? autofillUnavailable(),
      getContact: id => autofill?.autofillGetContact(id) ?? autofillUnavailable(),
      saveContact: contact => autofill?.autofillSaveContact(contact) ?? autofillUnavailable(),
      removeContact: id => autofill?.autofillRemoveContact(id) ?? autofillUnavailable(),
      hooks: { snapshot: scope },
    })
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'browser',
      order: 5,
      label: () => t('browser.nav'),
      locale: 'settings.browser',
      inject: injected,
      children: { 'settings.browser.item': { kind: 'list', scope: 'root' } },
    }, BrowserSection))
  }

  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'conversation': { kind: 'single', scope: 'session-maybe' },
        'details': { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the factory itself — the framework instantiates per
      // entry and delivers useStore/actions to AppFrame as standard props.
      store: createLayoutStore,
      // The hook's only side effect connects the root store to ctx.layout;
      // conversation business actions belong to their registrants.
      inject: (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {
          createSideSession: async () => {
            const sessions = ctx.sessions.list.getSnapshot()
            const workspaces = ctx.workspaces.list.getSnapshot()
            const current = sessions.current === undefined ? undefined : sessions.byId[sessions.current]
            const currentWorkspace = current === undefined
              ? undefined
              : workspaces.items.find(item => item.sessionIds.includes(current.id))
            if (currentWorkspace !== undefined) {
              return await ctx.sessions.create({ workspaceId: currentWorkspace.workspaceId })
            }
            if (current?.cwd !== undefined) return await ctx.sessions.create({ cwd: current.cwd })
            const recent = workspaces.items.find(item => item.workspaceId === workspaces.recentWorkspaceId)
            if (recent !== undefined) return await ctx.sessions.create({ workspaceId: recent.workspaceId })
            throw new Error('Open a workspace before creating a side chat.')
          },
        }
      },
    }, AppFrame)
    return () => {
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}
