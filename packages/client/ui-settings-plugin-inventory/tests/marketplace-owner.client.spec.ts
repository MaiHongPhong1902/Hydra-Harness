import { describe, expect, it } from 'vitest'
import { groupByOwner, marketplaceOwnerLabel, matchesQuery } from '../src/client/marketplace-owner.ts'

describe('marketplaceOwnerLabel', () => {
  it('takes the path segment right after the domain for an HTTPS URL', () => {
    expect(marketplaceOwnerLabel('https://github.com/example-labs/toolkit')).toBe('example-labs')
    expect(marketplaceOwnerLabel('https://github.com/example/plugins.git')).toBe('example')
  })

  it('takes the owner from a Git scp-style source', () => {
    expect(marketplaceOwnerLabel('git@github.com:example-labs/toolkit.git')).toBe('example-labs')
  })

  it('takes the owner from GitHub shorthand', () => {
    expect(marketplaceOwnerLabel('example-labs/toolkit')).toBe('example-labs')
  })

  it('falls back to the last path segment for a local marketplace root', () => {
    expect(marketplaceOwnerLabel('C:\\plugins\\toolkit')).toBe('toolkit')
    expect(marketplaceOwnerLabel('localplugin')).toBe('localplugin')
  })

  it('falls back to the host when a URL has no owner segment', () => {
    expect(marketplaceOwnerLabel('https://github.com')).toBe('github.com')
  })

  it('falls back to the source itself when nothing else applies', () => {
    expect(marketplaceOwnerLabel('')).toBe('')
  })
})

describe('groupByOwner', () => {
  it('groups items by owner label, sorted by owner name, preserving item order within a group', () => {
    const items = [
      { source: 'https://github.com/example-labs/toolkit', name: 'toolkit' },
      { source: 'https://github.com/acme/widgets', name: 'widgets' },
      { source: 'https://github.com/example-labs/other', name: 'other' },
    ]

    const groups = groupByOwner(items, item => item.source)

    expect(groups.map(group => group.owner)).toEqual(['acme', 'example-labs'])
    expect(groups[0]?.items.map(item => item.name)).toEqual(['widgets'])
    expect(groups[1]?.items.map(item => item.name)).toEqual(['toolkit', 'other'])
  })
})

describe('matchesQuery', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesQuery(['Toolkit'], '')).toBe(true)
  })

  it('matches case-insensitively against any haystack value', () => {
    expect(matchesQuery(['Toolkit', 'toolkit@local'], 'local')).toBe(true)
    expect(matchesQuery(['Toolkit'], 'nope')).toBe(false)
  })
})
