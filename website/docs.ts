/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier; this manifest maps each
 * canonical source into the site's route tree rather than copying Markdown.
 */

/** Sidebar collection rendered for one top-level module. */
export type DocsSidebar = 'guide' | 'develop' | 'reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for the site home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Heading levels included in this page's VitePress outline. */
  outline?: number | readonly [number, number] | 'deep' | false
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

const homeAndGuide: DocsPage[] = [
  {
    source: 'docs/user/index.md',
    route: 'index.md',
    label: 'Hydra harness',
    sidebar: null,
    section: 'Home',
    order: 0,
  },
  {
    source: 'docs/user/guide/index.md',
    route: 'guide/quickstart.md',
    label: 'Use the Web UI',
    sidebar: 'guide',
    section: 'Guide',
    order: 1,
    sourceAliases: ['docs/user/guide'],
  },
  {
    source: 'docs/user/guide/providers.md',
    route: 'guide/providers.md',
    label: 'Configure models',
    sidebar: 'guide',
    section: 'Guide',
    order: 2,
  },
  {
    source: 'docs/user/guide/desktop.md',
    route: 'guide/desktop.md',
    label: 'Use the desktop app',
    sidebar: 'guide',
    section: 'Guide',
    order: 3,
  },
  {
    source: 'docs/user/guide/python-sdk.md',
    route: 'guide/python-sdk.md',
    label: 'Python',
    sidebar: 'guide',
    section: 'SDK',
    order: 1,
  },
]

const develop: DocsPage[] = [
  {
    source: 'docs/user/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: 'Your first Harness plugin',
    sidebar: 'develop',
    section: 'Basics',
    order: 1,
    sourceAliases: ['docs/user/develop/basic'],
  },
  {
    source: 'docs/user/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: 'Build a tool',
    sidebar: 'develop',
    section: 'Basics',
    order: 2,
  },
  {
    source: 'docs/user/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: 'Plugin configuration',
    sidebar: 'develop',
    section: 'Basics',
    order: 3,
  },
  {
    source: 'docs/user/develop/basic/publish.md',
    route: 'develop/basic/publish.md',
    label: 'Package and install',
    sidebar: 'develop',
    section: 'Basics',
    order: 4,
  },
  {
    source: 'docs/user/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: 'Plugin lifecycle',
    sidebar: 'develop',
    section: 'Framework',
    order: 1,
    sourceAliases: ['docs/user/develop/framework'],
  },
  {
    source: 'docs/user/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: 'Services and dependencies',
    sidebar: 'develop',
    section: 'Framework',
    order: 2,
  },
  {
    source: 'docs/user/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: 'Event system',
    sidebar: 'develop',
    section: 'Framework',
    order: 3,
  },
  {
    source: 'docs/user/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: 'Capability layering',
    sidebar: 'develop',
    section: 'Practice',
    order: 1,
    sourceAliases: ['docs/user/develop/practice'],
  },
  {
    source: 'docs/user/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: 'LLM adapter',
    sidebar: 'develop',
    section: 'Practice',
    order: 2,
  },
]

const cordisTutorial: DocsPage[] = ([
  ['index.md', 'Overview'],
  ['01-first-plugin.md', '1. Your first plugin'],
  ['02-lifecycle-and-effects.md', '2. Lifecycle and effects'],
  ['03-services.md', '3. Services'],
  ['04-events.md', '4. Events'],
  ['05-config.md', '5. Configuration'],
  ['06-composition-and-hmr.md', '6. Composition and HMR'],
  ['07-into-the-harness.md', '7. Into the harness'],
] as const).map(([file, label], order): DocsPage => ({
  source: `docs/cordis-tutorial/${file}`,
  route: `develop/cordis-tutorial/${file}`,
  label,
  sidebar: 'develop',
  section: 'Cordis framework tutorial',
  order,
  ...(file === 'index.md' ? { sourceAliases: ['docs/cordis-tutorial'] } : {}),
}))

const cordisPrimerReference: DocsPage[] = [
  {
    source: 'docs/cordis-primer.md',
    route: 'reference/cordis-primer.md',
    label: 'Cordis primer',
    sidebar: 'reference',
    section: 'Concepts',
    order: 1,
  },
]

/**
 * Subsystem pages grouped by the concern they document, as `[section, pages]`.
 * One flat list of every subsystem pushed the rest of the reference sidebar
 * below the fold.
 */
const subsystemGroups = [
  ['Overview', [
    ['README.md', 'Subsystems'],
  ]],
  ['Core and scopes', [
    ['core.md', 'Core'],
    ['scope.md', 'Scopes'],
    ['invariants.md', 'Runtime invariants'],
  ]],
  ['Sessions and persistence', [
    ['session.md', 'Sessions'],
    ['session-query.md', 'Session query'],
    ['session-reference.md', 'Session references'],
    ['session-title.md', 'Session titles'],
    ['session-projection.md', 'Session projections'],
    ['persistence.md', 'Session persistence'],
    ['spill.md', 'Spill storage'],
    ['session-telemetry.md', 'SessionTelemetryBackend'],
  ]],
  ['Model and context', [
    ['llm-streaming.md', 'LLM streaming'],
    ['token-meter.md', 'Token metering'],
    ['system-prompt.md', 'System prompts'],
    ['compaction.md', 'Compaction'],
  ]],
  ['Execution and tools', [
    ['tools.md', 'Tools'],
    ['shell.md', 'Bash execution'],
    ['subprocess.md', 'Subprocesses'],
    ['terminal.md', 'PTY sessions'],
    ['jobs.md', 'Background jobs'],
    ['filesystem.md', 'Filesystem'],
    ['lsp.md', 'LSP navigation'],
    ['code-runtime.md', 'Code runtime'],
    ['web.md', 'Web access'],
    ['skills.md', 'Skills'],
    ['workflow.md', 'Workflows'],
    ['subagent.md', 'Subagents'],
  ]],
  ['Policy and interaction', [
    ['approval.md', 'Approvals'],
    ['permission-presets.md', 'Permission presets'],
    ['sandbox.md', 'Sandboxing'],
    ['plan.md', 'Plan mode'],
    ['user-questions.md', 'User interaction'],
    ['commands.md', 'Human commands'],
    ['goal.md', 'Goals'],
    ['schedule.md', 'Scheduled reminders'],
  ]],
  ['Platform and access', [
    ['web-server.md', 'HTTP server'],
    ['typert.md', 'Typert'],
    ['client-modules.md', 'Client modules'],
    ['storage.md', 'Storage'],
    ['workspace.md', 'Workspaces'],
    ['settings.md', 'User settings'],
    ['credentials.md', 'User credentials'],
  ]],
] as const

const subsystemsReference: DocsPage[] = subsystemGroups.flatMap(([section, files]) =>
  files.map(([file, label], order): DocsPage => ({
    source: `docs/subsystems/${file}`,
    route: file === 'README.md' ? 'reference/subsystems/index.md' : `reference/subsystems/${file}`,
    label,
    sidebar: 'reference',
    section,
    order,
    // Subsystem pages carry long third-level sections a two-level outline reaches.
    outline: [2, 3],
    ...(file === 'README.md' ? { sourceAliases: ['docs/subsystems'] } : {}),
  })),
)

const reference: DocsPage[] = [
  {
    source: 'docs/architecture.md',
    route: 'reference/index.md',
    label: 'Architecture',
    sidebar: 'reference',
    section: 'Concepts',
    order: 0,
  },
  ...([
    ['docs/capability-seams.md', 'reference/capability-seams.md', 'Capability services', 2],
    ['docs/agent-lifecycle.md', 'reference/agent-lifecycle.md', 'Agent lifecycle', 3],
    ['docs/tool-execution-pipeline.md', 'reference/tool-execution-pipeline.md', 'Tool execution', 4],
  ] as const).map(([source, route, label, order]): DocsPage => ({
    source,
    route,
    label,
    sidebar: 'reference',
    section: 'Concepts',
    order,
  })),
  ...([
    ['docs/config-catalog.md', 'reference/config-catalog.md', 'Plugin configuration'],
    ['docs/tool-catalog.md', 'reference/tool-catalog.md', 'Tool schemas'],
    ['docs/persistence-catalog.md', 'reference/persistence-catalog.md', 'Persistence events', 'deep'],
  ] as const).map(([source, route, label, outline], order): DocsPage => ({
    source,
    route,
    label,
    sidebar: 'reference',
    section: 'Generated reference',
    order,
    ...(outline === undefined ? {} : { outline }),
  })),
  ...([
    ['context.md', 'Context'],
    ['events.md', 'Events'],
    ['fiber.md', 'Fiber'],
    ['registry.md', 'Plugin Registry'],
    ['service.md', 'Service'],
    ['inherited.md', 'Inherited surface'],
  ] as const).map(([file, label], order): DocsPage => ({
    source: `docs/cordis-api/${file}`,
    route: `reference/cordis-api/${file}`,
    label,
    sidebar: 'reference',
    section: 'Cordis Core API',
    order,
  })),
  ...([
    ['adding-a-package.md', 'Adding a package'],
    ['adding-a-tool.md', 'Adding a tool'],
    ['adding-an-llm-adapter.md', 'Adding an LLM adapter'],
    ['adding-a-settings-card.md', 'Adding a settings card'],
    ['extension-cookbook.md', 'Extension patterns'],
    ['adding-a-conversation-node.md', 'Adding a Conversation Node'],
  ] as const).map(([file, label], order): DocsPage => ({
    source: `docs/cookbook/${file}`,
    route: `reference/cookbook/${file}`,
    label,
    sidebar: 'reference',
    section: 'Cookbook',
    order,
  })),
]

/**
 * Sidebar collections in the order the site's navigation presents them. The
 * navigation bar and the llms.txt index both read this sequence, so a new
 * collection lands in both surfaces together.
 */
export const collections = ['guide', 'develop', 'reference'] as const satisfies readonly DocsSidebar[]

/** A sidebar group, matched to pages by `label`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * Every sidebar group, in the order the site renders it.
 *
 * The subsystem groups collapse because together they outnumber the rest of the
 * reference sidebar; expanded, they push every other group below the fold.
 */
const sections: readonly DocsSection[] = [
  { label: 'Guide' }, { label: 'SDK' },
  { label: 'Basics' }, { label: 'Framework' }, { label: 'Practice' }, { label: 'Cordis framework tutorial' },
  { label: 'Concepts' }, { label: 'Generated reference' }, { label: 'Cordis Core API' }, { label: 'Cookbook' },
  { label: 'Overview' },
  { label: 'Core and scopes', collapsed: true },
  { label: 'Sessions and persistence', collapsed: true },
  { label: 'Model and context', collapsed: true },
  { label: 'Execution and tools', collapsed: true },
  { label: 'Policy and interaction', collapsed: true },
  { label: 'Platform and access', collapsed: true },
]

/**
 * Placement and collapse behavior of one sidebar group.
 *
 * @param label - Section label carried by the pages in the group.
 * @returns The declared group, plus its zero-based position.
 * @throws When no placement is declared for the label. Ranking by list
 *   membership alone would sort an undeclared group silently ahead of every
 *   declared one.
 */
export function sectionSpec(label: string): DocsSection & { index: number } {
  const section = sections.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no declared placement.`)
  return { ...section, index: sections.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...homeAndGuide,
  ...develop,
  ...cordisTutorial,
  ...cordisPrimerReference,
  ...subsystemsReference,
  ...reference,
]

/**
 * Pages of one sidebar collection, in the order the sidebar lists them.
 *
 * @param collection - Sidebar collection to read.
 * @returns The collection's pages, ordered by section placement then by `order`.
 */
export function orderedPages(collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(left.section).index - sectionSpec(right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * Where a top-level navigation item lands.
 *
 * The target is derived rather than written down: a collection whose first page
 * is renamed or reordered would otherwise leave the navigation bar pointing at
 * a route the manifest no longer publishes.
 *
 * @param collection - Sidebar collection the item opens.
 * @returns Site-relative link of the collection's first page.
 * @throws When the collection publishes no page.
 */
export function landingLink(collection: DocsSidebar): string {
  const first = orderedPages(collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}
