import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

interface LoginMetadata {
  id: string
  origin: string
  username: string
  createdAt: string
  updatedAt: string
}

interface Login extends LoginMetadata {
  password: string
}

interface ContactMetadata {
  id: string
  label: string
  createdAt: string
  updatedAt: string
}

interface Contact extends ContactMetadata {
  fields: Record<string, string>
}

interface Vault {
  listLogins(): Promise<LoginMetadata[]>
  saveLogin(value: { id?: string; origin: string; username: string; password?: string }): Promise<LoginMetadata>
  removeLogin(id: string): Promise<boolean>
  resolveLogin(id: string): Promise<Login | undefined>
  listContacts(): Promise<ContactMetadata[]>
  saveContact(value: { id?: string; label: string; fields: Record<string, string> }): Promise<ContactMetadata>
  removeContact(id: string): Promise<boolean>
  resolveContact(id: string): Promise<Contact | undefined>
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface VaultModule {
  createAutofillVault: (options: { filename: string; safeStorage: SafeStorageLike }) => Vault
}

const { createAutofillVault } = createRequire(import.meta.url)('../electron-app/autofill-vault.cjs') as VaultModule
const temporaryDirectories: string[] = []

class FakeSafeStorage implements SafeStorageLike {
  readonly key = randomBytes(32)
  available = true
  backend = 'dpapi'

  isEncryptionAvailable(): boolean {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  encryptString(value: string): Buffer {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  decryptString(value: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12))
    decipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
  }
}

async function location(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'bh-autofill-vault-'))
  temporaryDirectories.push(directory)
  return { directory, filename: join(directory, 'autofill.json') }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => rm(directory, { recursive: true, force: true })))
})

describe('autofill vault', () => {
  it('encrypts the complete payload and returns passwords only through main-only resolution', async () => {
    const { filename } = await location()
    const safeStorage = new FakeSafeStorage()
    const vault = createAutofillVault({ filename, safeStorage })
    const login = await vault.saveLogin({
      origin: 'https://example.test/login?from=settings', username: 'person@example.test', password: 'correct horse',
    })
    const contact = await vault.saveContact({
      label: 'Home',
      fields: { name: 'Example Person', email: 'person@example.test', countryCode: 'de' },
    })

    expect(login).toEqual(expect.objectContaining({ origin: 'https://example.test', username: 'person@example.test' }))
    expect(login).not.toHaveProperty('password')
    expect(await vault.listLogins()).toEqual([login])
    expect(await vault.listContacts()).toEqual([contact])
    expect(JSON.stringify(await vault.listLogins())).not.toContain('correct horse')

    const stored = await readFile(filename, 'utf8')
    for (const plaintext of ['person@example.test', 'correct horse', 'Example Person', 'Home']) {
      expect(stored).not.toContain(plaintext)
    }
    const envelope: unknown = JSON.parse(stored)
    expect(typeof envelope).toBe('object')
    expect(envelope).not.toBeNull()
    const envelopeRecord = envelope as Record<string, unknown>
    expect(Object.keys(envelopeRecord).sort()).toEqual(['ciphertext', 'version'])
    expect(envelopeRecord.version).toBe(1)
    expect(typeof envelopeRecord.ciphertext).toBe('string')
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)

    const reloaded = createAutofillVault({ filename, safeStorage })
    expect(await reloaded.resolveLogin(login.id)).toEqual({ ...login, password: 'correct horse' })
    expect(await reloaded.resolveContact(contact.id)).toEqual({
      ...contact,
      fields: { name: 'Example Person', email: 'person@example.test', countryCode: 'DE' },
    })
  })

  it('preserves an omitted password, generates ids, deletes explicitly, and serializes concurrent writes', async () => {
    const { directory, filename } = await location()
    const safeStorage = new FakeSafeStorage()
    const vault = createAutofillVault({ filename, safeStorage })
    const original = await vault.saveLogin({
      origin: 'https://example.test', username: 'old', password: 'kept-secret',
    })
    expect(original.id).toMatch(/^[0-9a-f-]{36}$/u)

    const updated = await vault.saveLogin({ id: original.id, origin: 'https://example.test', username: 'new' })
    expect((await vault.resolveLogin(updated.id))?.password).toBe('kept-secret')

    await Promise.all(Array.from({ length: 16 }, async (_, index) => vault.saveLogin({
      origin: `https://site-${String(index)}.test`, username: `user-${String(index)}`, password: `secret-${String(index)}`,
    })))
    expect(await vault.listLogins()).toHaveLength(17)
    expect(await vault.removeLogin(updated.id)).toBe(true)
    expect(await vault.removeLogin(updated.id)).toBe(false)
    expect(await vault.resolveLogin(updated.id)).toBeUndefined()
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([])

    const reloaded = createAutofillVault({ filename, safeStorage })
    expect(await reloaded.listLogins()).toHaveLength(16)
  })

  it('fails closed without native encryption and rejects the basic-text backend', async () => {
    const { filename } = await location()
    const unavailable = new FakeSafeStorage()
    unavailable.available = false
    expect(() => createAutofillVault({ filename, safeStorage: unavailable }))
      .toThrow(expect.objectContaining({ code: 'AUTOFILL_VAULT_UNAVAILABLE' }))

    const plaintext = new FakeSafeStorage()
    plaintext.backend = 'basic_text'
    expect(() => createAutofillVault({ filename, safeStorage: plaintext }))
      .toThrow(expect.objectContaining({ code: 'AUTOFILL_VAULT_UNAVAILABLE' }))

    const unsupportedBackend = new FakeSafeStorage()
    unsupportedBackend.getSelectedStorageBackend = () => { throw new Error('unsupported platform') }
    if (process.platform === 'linux') {
      expect(() => createAutofillVault({ filename, safeStorage: unsupportedBackend }))
        .toThrow(expect.objectContaining({ code: 'AUTOFILL_VAULT_UNAVAILABLE' }))
    } else {
      expect(() => createAutofillVault({ filename, safeStorage: unsupportedBackend })).not.toThrow()
    }
  })

  it('rejects invalid durable data and unbounded input without overwriting it', async () => {
    const { directory, filename } = await location()
    const safeStorage = new FakeSafeStorage()
    const invalidPayload = JSON.stringify({
      version: 1,
      logins: [{
        id: 'not-generated-by-main',
        origin: 'https://example.test/path',
        username: 'person',
        password: 'secret',
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      }],
      contacts: [],
    })
    const ciphertext = safeStorage.encryptString(invalidPayload).toString('base64')
    const original = JSON.stringify({ version: 1, ciphertext })
    await writeFile(filename, original, { mode: 0o600 })

    await expect(createAutofillVault({ filename, safeStorage }).listLogins())
      .rejects.toMatchObject({ code: 'AUTOFILL_VAULT_INVALID' })
    expect(await readFile(filename, 'utf8')).toBe(original)

    const whitespaceContactFilename = join(directory, 'whitespace-contact.json')
    const whitespaceContactPayload = JSON.stringify({
      version: 1,
      logins: [],
      contacts: [{
        id: '00000000-0000-4000-8000-000000000000',
        label: '   ',
        fields: { email: 'person@example.test' },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      }],
    })
    const whitespaceContact = JSON.stringify({
      version: 1,
      ciphertext: safeStorage.encryptString(whitespaceContactPayload).toString('base64'),
    })
    await writeFile(whitespaceContactFilename, whitespaceContact, { mode: 0o600 })
    await expect(createAutofillVault({ filename: whitespaceContactFilename, safeStorage }).listContacts())
      .rejects.toMatchObject({ code: 'AUTOFILL_VAULT_INVALID' })
    expect(await readFile(whitespaceContactFilename, 'utf8')).toBe(whitespaceContact)

    const clean = join(directory, 'bounded.json')
    const vault = createAutofillVault({ filename: clean, safeStorage })
    await expect(vault.saveLogin({ origin: 'https://example.test', username: 'person', password: 'x'.repeat(65_537) }))
      .rejects.toMatchObject({ code: 'AUTOFILL_VAULT_INVALID' })
    await expect(vault.saveContact({ label: 'Empty', fields: {} }))
      .rejects.toMatchObject({ code: 'AUTOFILL_VAULT_INVALID' })
  })
})
