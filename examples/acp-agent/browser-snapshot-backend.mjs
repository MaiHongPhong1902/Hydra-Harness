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
    'Interactive elements from top layer of the current page inside the viewport:',
    '[0]<input id=who placeholder=Requester/>',
    "\t[1]<button id=submit>Place order</button>",
  ].join('\n'),
  after: [
    'Interactive elements from top layer of the current page inside the viewport:',
    '[0]<input id=who placeholder=Requester/>',
    "\t[1]<button id=submit>Place order</button>",
    '*[2]<p id=result>Ordered l for Ada</p>',
  ].join('\n'),
}

/** A child speaking the real protocol over real streams, with canned answers. */
class ScriptedChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  ordered = false

  constructor() {
    super()
    createInterface({ input: this.stdin }).on('line', line => {
      const { id, method } = JSON.parse(line)
      if (method === 'click_element') this.ordered = true
      this.stdout.write(`${JSON.stringify({ id, ok: true, result: this.answer(method) })}\n`)
    })
    this.stdin.on('finish', () => this.emit('exit'))
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`))
  }

  /**
   * What the Electron main process would reply to one protocol method.
   * @param {string} method - the protocol method name.
   * @returns {Record<string, unknown>} a state object, or an action report.
   */
  answer(method) {
    if (method === 'get_browser_state') {
      return {
        ...PAGE,
        content: this.ordered ? PAGE.after : PAGE.before,
        tabs: [{ id: 1, url: PAGE.url, title: PAGE.title, status: 'complete', active: true }],
        tabId: 1,
        activeTabId: 1,
        settled: true,
        capturedAt: '2026-08-24T00:00:00.000Z',
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
