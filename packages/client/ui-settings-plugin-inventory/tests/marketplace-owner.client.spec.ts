import { describe, expect, it } from 'vitest'
import { groupByOwner, marketplaceOwnerLabel, matchesQuery } from '../src/client/marketplace-owner.ts'

describe('marketplaceOwnerLabel', () => {
  it('takes the path segment right after the domain for an HTTPS URL', () => {
    expect(marketplaceOwnerLabel('https://github.com/DietrichGebert/ponytail')).toBe('DietrichGebert')
    expect(marketplaceOwnerLabel('https://github.com/example/plugins.git')).toBe('example')
  })

  it('takes the owner from a Git scp-style source', () => {
    expect(marketplaceOwnerLabel('git@github.com:DietrichGebert/ponytail.git')).toBe('DietrichGebert')
  })

  it('takes the owner from GitHub shorthand', () => {
    expect(marketplaceOwnerLabel('DietrichGebert/ponytail')).toBe('DietrichGebert')
  })

  it('falls back to the last path segment for a local marketplace root', () => {
    expect(marketplaceOwnerLabel('C:\\plugins\\ponytail')).toBe('ponytail')
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
      { source: 'https://github.com/DietrichGebert/ponytail', name: 'ponytail' },
      { source: 'https://github.com/acme/widgets', name: 'widgets' },
      { source: 'https://github.com/DietrichGebert/other', name: 'other' },
    ]

    const groups = groupByOwner(items, item => item.source)

    expect(groups.map(group => group.owner)).toEqual(['acme', 'DietrichGebert'])
    expect(groups[0]?.items.map(item => item.name)).toEqual(['widgets'])
    expect(groups[1]?.items.map(item => item.name)).toEqual(['ponytail', 'other'])
  })
})

describe('matchesQuery', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesQuery(['Ponytail'], '')).toBe(true)
  })

  it('matches case-insensitively against any haystack value', () => {
    expect(matchesQuery(['Ponytail', 'ponytail@local'], 'local')).toBe(true)
    expect(matchesQuery(['Ponytail'], 'nope')).toBe(false)
  })
})
