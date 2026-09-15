/**
 * Deterministic stand-in for the Electron process behind `ctx.browsers`.
 *
 * Only the child process is faked, through the service's own `spawnChild` test
 * seam: the real service, its per-owner queue, the real NDJSON framing, the
 * real tools, bounding, and rendering all run. A real window would need a
 * 200 MB binary, a display, and would report host-dependent viewport metrics —
 * exactly the expensive, non-deterministic boundary a snapshot may replace.
 */

import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

/** The one page this browser knows, before and after the order is placed. */
const PAGE = {
  url: 'https://shop.test/order',
  title: 'Order form',
  header: 'Current Page: [Order form](https://shop.test/order)\nPage info: 1280x900px viewport, 1280x900px total page size',
  footer: '... end of page ...',
  before: [
    'Accessibility controls:',
    '[0]<textbox id=who>Requester</textbox>',
    "\t[1]<button id=submit>Place order</button>",
  ].join('\n'),
  after: [
    'Accessibility controls:',
    '[0]<textbox id=who>Requester</textbox>',
    "\t[1]<button id=submit>Place order</button>",
    'Ordered l for Ada',
    '[2]<dialog>Order confirmed</dialog>',
    '[3]<button>Close confirmation</button>',
  ].join('\n'),
}

/** A child speaking the real protocol over real streams, with canned answers. */
class ScriptedChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  ordered = false
  observedOrder = false

  constructor() {
    super()
    createInterface({ input: this.stdin }).on('line', line => {
      const { id, method, args } = JSON.parse(line)
      if (method === 'click_element') this.ordered = true
      this.stdout.write(`${JSON.stringify({ id, ok: true, result: this.answer(method, args) })}\n`)
    })
    this.stdin.on('finish', () => this.emit('exit'))
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  /**
   * What the Electron main process would reply to one protocol method.
   * @param {string} method - the protocol method name.
   * @param {Record<string, unknown>} args - projected snapshot or action arguments.
   * @returns {Record<string, unknown>} a state object, or an action report.
   */
  answer(method, args) {
    if (method === 'find_element') {
      if (args.regex === '/Ordered l for Ada/') return { success: this.ordered, message: this.ordered ? 'Found 1 matching node:\n- paragraph [ref=e18]: Ordered l for Ada' : 'No matching accessibility nodes.' }
      return { success: true, message: 'Found 1 matching node:\n- button "Place order" [ref=e17]' }
    }
    if (method === 'network_requests') return { success: true, message: '[3] POST https://shop.test/api/order 200' }
    if (method === 'network_request') return { success: false, message: 'Request is unavailable or expired. Read browser_network_requests for current indexes.' }
    if (method === 'select_text') {
      return { success: true, message: 'Selected text: "Ada".', selectedText: 'Ada' }
    }
    if (method === 'get_browser_state') {
      const uiChanges = this.ordered && !this.observedOrder ? {
        shown: ['[2]<dialog>Order confirmed</dialog>', '[3]<button>Close confirmation</button>'],
        hidden: [], expanded: [], collapsed: [], changed: [], focused: '[3]<button>Close confirmation</button>',
      } : undefined
      if (args.metadataOnly !== true) this.observedOrder = this.ordered
      return {
        ...PAGE,
        content: args.snapshot === undefined ? (this.ordered ? PAGE.after : PAGE.before) : args.snapshot.target === 'e18' ? '- paragraph [ref=e18]: Ordered l for Ada' : '- button "Place order" [ref=e17]',
        tabs: [{ id: 1, url: PAGE.url, title: PAGE.title, status: 'complete', active: true }],
        tabId: 1,
        activeTabId: 1,
        settled: true,
        capturedAt: '2026-08-24T00:00:00.000Z',
        ...uiChanges === undefined ? {} : { uiChanges },
      }
    }
    return { success: true, message: `${method} succeeded` }
  }

  kill() {
    this.emit('exit')
  }
}

/** Cordis plugin name. */
export const name = 'browser-snapshot-backend'
/** The embedded-browser service whose spawn seam this replaces. */
export const inject = ['browsers']

/** Point the real service at a scripted child instead of Electron. */
export function apply(ctx) {
  ctx.browsers.spawnChild = () => new ScriptedChild()
}
