/** Shared marketplace-owner grouping and query matching for the Plugins, Skills, Hooks, and Marketplace tabs. */

/** One marketplace-owner group of items, ordered by owner name. */
export interface OwnerGroup<T> {
  readonly owner: string
  readonly items: readonly T[]
}

/**
 * Derive a marketplace's default group name: the path segment right after its
 * domain (`https://github.com/example-labs/toolkit` -> `example-labs`).
 * Falls back to the GitHub-shorthand or scp-style Git owner, and finally to
 * the source's own last path segment for a local marketplace root, which has
 * no owner.
 * @param source - a marketplace source: an HTTPS/SSH Git URL, GitHub shorthand, or local root path.
 * @returns the owner segment, or a local-root fallback label.
 */
export function marketplaceOwnerLabel(source: string): string {
  // `new URL()` misreads a Windows drive letter (`C:\...`) as a one-letter scheme instead of throwing,
  // so only attempt URL parsing when the source has an actual scheme separator.
  if (source.includes('://')) {
    try {
      const { pathname } = new URL(source)
      const [owner] = pathname.split('/').filter(part => part.length > 0)
      if (owner !== undefined) return owner
    } catch { /* malformed URL: fall through */ }
  }
  const scp = /^[^/\s]+@[^:/\s]+:([^/\s]+)/u.exec(source)
  if (scp?.[1] !== undefined) return scp[1]
  const shorthand = /^([\w.-]+)\/[\w.-]+$/u.exec(source)
  if (shorthand?.[1] !== undefined) return shorthand[1]
  // Local marketplace roots have no owner; label by folder name instead.
  const segments = source.split(/[/\\]/u).filter(part => part.length > 0)
  return segments.at(-1) ?? source
}

/**
 * Group items by their marketplace-owner label, sorted by owner name.
 * @param items - the items to group.
 * @param ownerSource - reads the marketplace source string from one item.
 * @returns groups sorted by owner name, each preserving the input order of its items.
 */
export function groupByOwner<T>(items: readonly T[], ownerSource: (item: T) => string): readonly OwnerGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const owner = marketplaceOwnerLabel(ownerSource(item))
    const bucket = groups.get(owner)
    if (bucket === undefined) groups.set(owner, [item])
    else bucket.push(item)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, groupItems]) => ({ owner, items: groupItems }))
}

/**
 * Whether any haystack value contains an already-trimmed, lowercased query.
 * @param haystack - candidate display values to search.
 * @param normalizedQuery - the shared search box text, already trimmed and lowercased.
 * @returns true when the query is empty or found in any haystack value.
 */
export function matchesQuery(haystack: readonly string[], normalizedQuery: string): boolean {
  return normalizedQuery.length === 0 || haystack.some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}
