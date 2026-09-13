import { describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import { CredentialProvider, credentialKey } from '@hydra/harness-credentials'
import type { Credential } from '@earendil-works/pi-ai'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@hydra/harness-credentials'
import { createAccountPool } from '../src/accounts.ts'

class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key)
    const next = await mutate(current)
    if (next !== undefined) this.records.set(key, next)
    return next ?? current
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

async function fixture(): Promise<{ ctx: Context; pool: ReturnType<typeof createAccountPool> }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  return {
    ctx,
    pool: createAccountPool({
      ctx,
      key: credentialKey('llm-account-auth', 'chatgpt'),
      providerId: 'chatgpt',
      providerLabel: 'ChatGPT',
    }),
  }
}

describe('account pools', () => {
  it('persists labels, isolates account reads, and rotates selection', async () => {
    const { ctx, pool } = await fixture()
    try {
      const first = await pool.add(' first ', {
        type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 1,
      })
      const second = await pool.add('second', {
        type: 'oauth', access: 'access-2', refresh: 'refresh-2', expires: 2,
      })
      expect(await pool.accounts.list()).toEqual([
        { id: first.id, label: 'first' },
        { id: second.id, label: 'second' },
      ])
      await pool.withAccount(first.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ access: 'access-1' })
      })
      await pool.withAccount(second.id, async () => {
        await expect(pool.credentials.read('chatgpt')).resolves.toMatchObject({ access: 'access-2' })
      })
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([{ id: first.id }, { id: second.id }])
      await expect(pool.selector.ordered('chatgpt')).resolves.toEqual([{ id: second.id }, { id: first.id }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('checks cancellation inside the serialized add mutation', async () => {
    const { ctx, pool } = await fixture()
    try {
      const controller = new AbortController()
      controller.abort('cancelled')
      await expect(pool.add('cancelled', {
        type: 'oauth', access: 'access', refresh: 'refresh', expires: 1,
      }, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
      await expect(pool.accounts.list()).resolves.toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hashes oversized combined token identities without collapsing users', async () => {
    const { ctx, pool } = await fixture()
    try {
      const account = 'a'.repeat(200)
      const firstUser = 'u'.repeat(200)
      const secondUser = 'v'.repeat(200)
      const grant = (userId: string) => ({
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: 1,
        accountId: account,
        userId,
      }) as Credential & Record<string, unknown>
      const added = await pool.add('first identity', grant(firstUser))
      const second = await pool.add('second identity', grant(secondUser))
      const relogged = await pool.add('first identity updated', grant(firstUser))
      expect(added.id).not.toBe(account)
      expect(added.id).not.toBe(second.id)
      expect(added.id).toBe(relogged.id)
      expect(added.id.length).toBeLessThanOrEqual(256)
      await expect(pool.accounts.list()).resolves.toEqual([
        { id: added.id, label: 'first identity updated' },
        { id: second.id, label: 'second identity' },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
