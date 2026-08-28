'use strict'

const { randomUUID } = require('node:crypto')
const { mkdir, readFile, rename, stat, unlink, writeFile } = require('node:fs/promises')
const { dirname, isAbsolute } = require('node:path')

const FILE_VERSION = 1
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_PLAINTEXT_BYTES = 2 * 1024 * 1024
const MAX_LOGINS = 500
const MAX_CONTACTS = 200
const MAX_USERNAME_BYTES = 320
const MAX_PASSWORD_BYTES = 64 * 1024
const MAX_LABEL_BYTES = 320
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const CONTACT_FIELD_LIMITS = Object.freeze({
  name: 320,
  givenName: 160,
  additionalName: 160,
  familyName: 160,
  organization: 320,
  email: 320,
  tel: 80,
  addressLine1: 500,
  addressLine2: 500,
  city: 200,
  region: 200,
  postalCode: 40,
  countryCode: 2,
})
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

class AutofillVaultError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'AutofillVaultError'
    this.code = code
  }
}

function fail(message, code = 'AUTOFILL_VAULT_INVALID') {
  throw new AutofillVaultError(message, code)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every(key => allowed.includes(key))
}

function boundedString(value, maxBytes, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(`autofill vault ${label} is invalid`)
  }
  return value
}

function timestamp(value) {
  if (typeof value !== 'string') fail('autofill vault timestamp is invalid')
  try {
    if (new Date(value).toISOString() !== value) fail('autofill vault timestamp is invalid')
  } catch {
    fail('autofill vault timestamp is invalid')
  }
  return value
}

function identifier(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('autofill vault id is invalid')
  return value
}

function canonicalOrigin(value) {
  boundedString(value, 2_048, 'origin')
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
      fail('autofill vault origin must be HTTP(S) without credentials')
    }
    return url.origin
  } catch (error) {
    if (error instanceof AutofillVaultError) throw error
    fail('autofill vault origin must be an absolute HTTP(S) URL')
  }
}

function storedLogin(value) {
  const keys = ['id', 'origin', 'username', 'password', 'createdAt', 'updatedAt']
  if (!hasExactKeys(value, keys) || Object.keys(value).length !== keys.length) {
    fail('autofill vault login record is invalid')
  }
  const origin = canonicalOrigin(value.origin)
  if (origin !== value.origin) fail('autofill vault stored origin is not canonical')
  const createdAt = timestamp(value.createdAt)
  const updatedAt = timestamp(value.updatedAt)
  if (createdAt > updatedAt) fail('autofill vault login timestamps are invalid')
  return {
    id: identifier(value.id),
    origin,
    username: boundedString(value.username, MAX_USERNAME_BYTES, 'username', true),
    password: boundedString(value.password, MAX_PASSWORD_BYTES, 'password'),
    createdAt,
    updatedAt,
  }
}

function contactFields(value) {
  const keys = Object.keys(CONTACT_FIELD_LIMITS)
  if (!hasExactKeys(value, keys)) fail('autofill vault contact fields are invalid')
  const fields = {}
  for (const [key, limit] of Object.entries(CONTACT_FIELD_LIMITS)) {
    if (value[key] === undefined) continue
    const field = boundedString(value[key], limit, `contact ${key}`).trim()
    if (field.length === 0) fail(`autofill vault contact ${key} is invalid`)
    fields[key] = key === 'countryCode' ? field.toUpperCase() : field
  }
  if (Object.keys(fields).length === 0) fail('autofill vault contact must contain at least one field')
  if (fields.countryCode !== undefined && !/^[A-Z]{2}$/u.test(fields.countryCode)) {
    fail('autofill vault contact countryCode is invalid')
  }
  return fields
}

function storedContact(value) {
  const keys = ['id', 'label', 'fields', 'createdAt', 'updatedAt']
  if (!hasExactKeys(value, keys) || Object.keys(value).length !== keys.length) {
    fail('autofill vault contact record is invalid')
  }
  const createdAt = timestamp(value.createdAt)
  const updatedAt = timestamp(value.updatedAt)
  if (createdAt > updatedAt) fail('autofill vault contact timestamps are invalid')
  const label = boundedString(value.label, MAX_LABEL_BYTES, 'contact label').trim()
  if (label.length === 0) fail('autofill vault contact label is invalid')
  return {
    id: identifier(value.id),
    label,
    fields: contactFields(value.fields),
    createdAt,
    updatedAt,
  }
}

function parsePayload(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PLAINTEXT_BYTES) {
    fail('autofill vault payload is invalid')
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail('autofill vault payload is invalid')
  }
  const keys = ['version', 'logins', 'contacts']
  if (!hasExactKeys(value, keys) || Object.keys(value).length !== keys.length || value.version !== FILE_VERSION
    || !Array.isArray(value.logins) || !Array.isArray(value.contacts)
    || value.logins.length > MAX_LOGINS || value.contacts.length > MAX_CONTACTS) {
    fail('autofill vault payload is invalid')
  }
  const ids = new Set()
  const admit = (record) => {
    if (ids.has(record.id)) fail('autofill vault contains a duplicate id')
    ids.add(record.id)
    return record
  }
  return {
    version: FILE_VERSION,
    logins: value.logins.map(entry => admit(storedLogin(entry))),
    contacts: value.contacts.map(entry => admit(storedContact(entry))),
  }
}

function parseEnvelope(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail('autofill vault file is invalid')
  }
  const keys = ['version', 'ciphertext']
  if (!hasExactKeys(value, keys) || Object.keys(value).length !== keys.length || value.version !== FILE_VERSION
    || typeof value.ciphertext !== 'string' || value.ciphertext.length === 0 || !BASE64.test(value.ciphertext)) {
    fail('autofill vault file is invalid')
  }
  const encrypted = Buffer.from(value.ciphertext, 'base64')
  if (encrypted.length === 0 || encrypted.toString('base64') !== value.ciphertext) {
    fail('autofill vault file is invalid')
  }
  return encrypted
}

function loginInput(value) {
  const keys = ['id', 'origin', 'username', 'password']
  if (!hasExactKeys(value, keys) || value.origin === undefined || value.username === undefined) {
    fail('autofill vault login input is invalid')
  }
  return {
    ...(value.id === undefined ? {} : { id: identifier(value.id) }),
    origin: canonicalOrigin(value.origin),
    username: boundedString(value.username, MAX_USERNAME_BYTES, 'username', true),
    ...(value.password === undefined
      ? {}
      : { password: boundedString(value.password, MAX_PASSWORD_BYTES, 'password') }),
  }
}

function contactInput(value) {
  const keys = ['id', 'label', 'fields']
  if (!hasExactKeys(value, keys) || value.label === undefined || value.fields === undefined) {
    fail('autofill vault contact input is invalid')
  }
  const label = boundedString(value.label, MAX_LABEL_BYTES, 'contact label').trim()
  if (label.length === 0) fail('autofill vault contact label is invalid')
  return {
    ...(value.id === undefined ? {} : { id: identifier(value.id) }),
    label,
    fields: contactFields(value.fields),
  }
}

function loginMetadata(record) {
  return {
    id: record.id,
    origin: record.origin,
    username: record.username,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function contactMetadata(record) {
  return { id: record.id, label: record.label, createdAt: record.createdAt, updatedAt: record.updatedAt }
}

function cloneLogin(record) {
  return { ...record }
}

function cloneContact(record) {
  return { ...record, fields: { ...record.fields } }
}

function assertSafeStorage(safeStorage) {
  if (!isRecord(safeStorage) || typeof safeStorage.isEncryptionAvailable !== 'function'
    || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new TypeError('autofill vault requires an Electron safeStorage implementation')
  }
  if (safeStorage.isEncryptionAvailable() !== true) {
    fail('secure autofill storage is unavailable', 'AUTOFILL_VAULT_UNAVAILABLE')
  }
  if (typeof safeStorage.getSelectedStorageBackend !== 'function') return
  try {
    if (safeStorage.getSelectedStorageBackend() === 'basic_text') {
      fail('secure autofill storage is unavailable', 'AUTOFILL_VAULT_UNAVAILABLE')
    }
  } catch (error) {
    if (error instanceof AutofillVaultError) throw error
    if (process.platform === 'linux') {
      fail('secure autofill storage is unavailable', 'AUTOFILL_VAULT_UNAVAILABLE')
    }
  }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      if (!RETRYABLE_RENAME_CODES.has(error?.code) || attempt >= 7) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** attempt, 100)))
    }
  }
}

function createAutofillVault(options) {
  if (!isRecord(options) || typeof options.filename !== 'string' || !isAbsolute(options.filename)) {
    throw new TypeError('autofill vault filename must be absolute')
  }
  const { filename, safeStorage } = options
  assertSafeStorage(safeStorage)

  let snapshot
  let operations = Promise.resolve()

  const emptyDocument = () => ({ version: FILE_VERSION, logins: [], contacts: [] })

  const load = async () => {
    let size
    try {
      size = (await stat(filename)).size
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyDocument()
      throw error
    }
    if (size > MAX_FILE_BYTES) fail('autofill vault file is too large')
    const text = await readFile(filename, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail('autofill vault file is too large')
    const encrypted = parseEnvelope(text)
    let plaintext
    try {
      plaintext = safeStorage.decryptString(encrypted)
    } catch {
      fail('autofill vault could not be decrypted')
    }
    return parsePayload(plaintext)
  }

  const persist = async (next) => {
    const plaintext = JSON.stringify(next)
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
      fail('autofill vault capacity exceeded', 'AUTOFILL_VAULT_LIMIT')
    }
    let encrypted
    try {
      encrypted = safeStorage.encryptString(plaintext)
    } catch {
      fail('autofill vault encryption failed', 'AUTOFILL_VAULT_UNAVAILABLE')
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      fail('autofill vault encryption failed', 'AUTOFILL_VAULT_UNAVAILABLE')
    }
    const serialized = `${JSON.stringify({ version: FILE_VERSION, ciphertext: encrypted.toString('base64') })}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
      fail('autofill vault capacity exceeded', 'AUTOFILL_VAULT_LIMIT')
    }
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
    let renamed = false
    try {
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await renameWithRetry(temporary, filename)
      renamed = true
    } finally {
      if (!renamed) {
        try {
          await unlink(temporary)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
  }

  const enqueue = (operation) => {
    const task = operations.then(async () => {
      snapshot ??= await load()
      return await operation(snapshot)
    })
    operations = task.then(() => undefined, () => undefined)
    return task
  }

  const freshId = (current) => {
    const ids = new Set([...current.logins, ...current.contacts].map(record => record.id))
    let id = randomUUID()
    while (ids.has(id)) id = randomUUID()
    return id
  }

  return Object.freeze({
    listLogins() {
      return enqueue(current => Promise.resolve(current.logins.map(loginMetadata)))
    },

    async saveLogin(value) {
      const input = loginInput(value)
      return enqueue(async (current) => {
        const index = input.id === undefined ? -1 : current.logins.findIndex(record => record.id === input.id)
        if (input.id !== undefined && index === -1) {
          fail('saved login does not exist', 'AUTOFILL_VAULT_NOT_FOUND')
        }
        if (index === -1 && current.logins.length >= MAX_LOGINS) {
          fail('saved login limit reached', 'AUTOFILL_VAULT_LIMIT')
        }
        const previous = index === -1 ? undefined : current.logins[index]
        if (previous === undefined && input.password === undefined) {
          fail('a new saved login requires a password')
        }
        const now = new Date().toISOString()
        const nextRecord = {
          id: previous?.id ?? freshId(current),
          origin: input.origin,
          username: input.username,
          password: input.password ?? previous.password,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        }
        const logins = [...current.logins]
        if (index === -1) logins.push(nextRecord)
        else logins[index] = nextRecord
        const next = { ...current, logins }
        await persist(next)
        snapshot = next
        return loginMetadata(nextRecord)
      })
    },

    async removeLogin(id) {
      const validId = identifier(id)
      return enqueue(async (current) => {
        const logins = current.logins.filter(record => record.id !== validId)
        if (logins.length === current.logins.length) return false
        const next = { ...current, logins }
        await persist(next)
        snapshot = next
        return true
      })
    },

    async resolveLogin(id) {
      const validId = identifier(id)
      return enqueue(current => Promise.resolve(
        current.logins.find(record => record.id === validId),
      )).then(record => record === undefined ? undefined : cloneLogin(record))
    },

    listContacts() {
      return enqueue(current => Promise.resolve(current.contacts.map(contactMetadata)))
    },

    async saveContact(value) {
      const input = contactInput(value)
      return enqueue(async (current) => {
        const index = input.id === undefined ? -1 : current.contacts.findIndex(record => record.id === input.id)
        if (input.id !== undefined && index === -1) {
          fail('saved contact does not exist', 'AUTOFILL_VAULT_NOT_FOUND')
        }
        if (index === -1 && current.contacts.length >= MAX_CONTACTS) {
          fail('saved contact limit reached', 'AUTOFILL_VAULT_LIMIT')
        }
        const previous = index === -1 ? undefined : current.contacts[index]
        const now = new Date().toISOString()
        const nextRecord = {
          id: previous?.id ?? freshId(current),
          label: input.label,
          fields: input.fields,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        }
        const contacts = [...current.contacts]
        if (index === -1) contacts.push(nextRecord)
        else contacts[index] = nextRecord
        const next = { ...current, contacts }
        await persist(next)
        snapshot = next
        return contactMetadata(nextRecord)
      })
    },

    async removeContact(id) {
      const validId = identifier(id)
      return enqueue(async (current) => {
        const contacts = current.contacts.filter(record => record.id !== validId)
        if (contacts.length === current.contacts.length) return false
        const next = { ...current, contacts }
        await persist(next)
        snapshot = next
        return true
      })
    },

    async resolveContact(id) {
      const validId = identifier(id)
      return enqueue(current => Promise.resolve(
        current.contacts.find(record => record.id === validId),
      )).then(record => record === undefined ? undefined : cloneContact(record))
    },
  })
}

module.exports = { AutofillVaultError, createAutofillVault }
