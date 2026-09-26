/**
 * Deterministic child for the page-memory ACP snapshot.
 *
 * The real BrowserSessionService, NDJSON protocol, tools, live selector
 * checks, and page-memory store remain in the composition. This child only
 * replaces the Electron process at its existing spawn seam.
 */

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

const ORDER_URL = 'https://shop.test/orders'
const HELP_URL = 'https://shop.test/help'
const PAGE_MEMORY_ROLE = 'order-operator'
const PAGE_MEMORY_LOCALE = 'en-US'

function assertPersistedWorkflow() {
  const namespace = {
    workspace: realpathSync(process.cwd()),
    role: PAGE_MEMORY_ROLE,
    locale: PAGE_MEMORY_LOCALE,
  }
  const databasePath = join(
    process.cwd(),
    createHash('sha256').update(JSON.stringify(namespace)).digest('hex'),
    'page-memory.sqlite',
  )
  const database = new DatabaseSync(databasePath)
  try {
    const row = database.prepare(
      'SELECT w.task, w.payload FROM workflows AS w JOIN pages AS p ON p.page_key = w.page_key WHERE w.task = ?',
    ).get('place_order')
    if (row === undefined || typeof row !== 'object' || row === null) {
      throw new Error('page-memory snapshot: SQLite workflow row is missing')
    }
    const payload = JSON.parse(String(row.payload))
    if (payload.task !== 'place_order' || payload.status !== 'verified') {
      throw new Error('page-memory snapshot: SQLite workflow row is not verified')
    }
    if (payload.accountHint !== 'Use a staff account with order-management access.') {
      throw new Error('page-memory snapshot: SQLite account-type guidance is missing')
    }
  } finally {
    database.close()
  }
}

function page(url) {
  if (url === ORDER_URL) {
    return {
      url,
      title: 'Orders',
      content: [
        'Accessibility controls:',
        '[0]<heading id=order-form>Order form</heading>',
        '[1]<textbox id=requester>Requester</textbox>',
        '\t[2]<button id=submit>Place order</button>',
      ].join('\n'),
    }
  }
  return {
    url,
    title: 'Help',
    content: [
      'Accessibility controls:',
      '[0]<heading id=help>Help center</heading>',
      '[1]<paragraph>Choose a page from the navigation.</paragraph>',
    ].join('\n'),
  }
}

/** A child speaking the real browser protocol over in-memory streams. */
class ScriptedChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  url = 'about:blank'
  requester = ''
  ordered = false
  visitedHelp = false
  partialAnchor = false

  constructor() {
    super()
    createInterface({ input: this.stdin }).on('line', line => {
      const { id, method, args = {} } = JSON.parse(line)
      try {
        this.stdout.write(`${JSON.stringify({ id, ok: true, result: this.answer(method, args) })}\n`)
      } catch (error) {
        this.stdout.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`)
      }
    })
    this.stdin.on('finish', () => this.emit('exit'))
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  /**
   * Answer one low-level Browser action.
   * @param {string} method - The action name from BrowserSessionService.
   * @param {Record<string, unknown>} args - Validated action arguments.
   * @returns {Record<string, unknown>} The protocol result.
   */
  answer(method, args) {
    if (method === 'navigate') {
      this.url = String(args.url)
      this.ordered = false
      if (this.url === HELP_URL) {
        assertPersistedWorkflow()
        this.visitedHelp = true
      }
      if (this.url === ORDER_URL && this.visitedHelp) {
        this.partialAnchor = true
        this.visitedHelp = false
      }
      return { success: true, message: 'navigate succeeded' }
    }
    if (method === 'input_text') {
      this.requester = String(args.text)
      return { success: true, message: 'input_text succeeded' }
    }
    if (method === 'click_element') {
      this.ordered = true
      return { success: true, message: 'click_element succeeded' }
    }
    if (method === 'find_element') {
      const expression = String(args.regex ?? args.query ?? args.text ?? '')
      const found = expression.includes('Order placed') && this.ordered
      return found
        ? { success: true, message: `Found 1 matching node:\n- paragraph [ref=e18]: Order placed for ${this.requester}` }
        : { success: false, message: 'No matching accessibility nodes.' }
    }
    if (method === 'get_page_identity') {
      const current = page(this.url)
      return { url: current.url, title: current.title, tabId: 1, activeTabId: 1, settled: true }
    }
    if (method === 'get_browser_state') {
      const current = page(this.url)
      let content = current.content
      const snapshot = args.snapshot
      if (this.url === ORDER_URL && this.ordered) content += `\n[3]<paragraph id=order-result>Order placed for ${this.requester}</paragraph>`
      if (snapshot !== undefined && typeof snapshot === 'object' && snapshot !== null) {
        const target = String(snapshot.target ?? '')
        if (target === '#order-form') {
          content = this.partialAnchor
            ? '- heading [ref=e10]: ArchivedOrder form'
            : '- heading [ref=e10]: Order\u200b\nform'
          this.partialAnchor = false
        }
        else if (target === '#requester') content = '- textbox [ref=e11]: Requester'
        else if (target === 'button[type="submit"]') content = '- button [ref=e12]: Place order'
        else if (target === '#order-result') content = this.ordered ? `- paragraph [ref=e18]: Order placed for ${this.requester}` : ''
      }
      return {
        ...current,
        header: `Current Page: [${current.title}](${current.url})\nPage info: 1280x900px viewport, 1280x900px total page size`,
        content,
        footer: '... end of page ...',
        tabs: [{ id: 1, url: current.url, title: current.title, status: 'complete', active: true }],
        tabId: 1,
        activeTabId: 1,
        settled: true,
        capturedAt: '2026-09-13T00:00:00.000Z',
      }
    }
    return { success: true, message: `${method} succeeded` }
  }

  kill() {
    this.emit('exit')
  }
}

/** Cordis plugin name. */
export const name = 'page-memory-snapshot-backend'
/** Browser service whose spawn seam this test plugin replaces. */
export const inject = ['browsers']

/** Replace Electron with the deterministic child. */
export function apply(ctx) {
  ctx.browsers.spawnChild = () => new ScriptedChild()
}
