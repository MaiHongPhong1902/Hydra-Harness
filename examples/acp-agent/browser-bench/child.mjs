/** Deterministic Electron boundary; the service and its NDJSON streams remain real. */
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

export class BenchmarkChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  active = 1
  pages = new Map()
  lastState
  actionFailures = 0

  constructor(scenario) {
    super()
    this.scenario = scenario
    this.pages.set(1, scenario.before)
    createInterface({ input: this.stdin }).on('line', line => {
      const { id, method, args } = JSON.parse(line)
      const result = this.answer(method, args)
      this.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`)
    })
    queueMicrotask(() => this.stdout.write('{"event":"ready"}\n'))
  }

  answer(method, args) {
    const tab = args.tabId ?? this.active
    if (method === 'get_browser_state') {
      const url = `https://bench.test/${this.scenario.name}${tab === 2 ? '/second' : ''}`
      this.lastState = {
        url, title: this.scenario.name,
        header: `Current Page: [${this.scenario.name}](${url})\nPage info: 1280x900px viewport, 1280x9000px total page size, 0 pages above, 9 pages below\n[Start of page]`,
        content: this.pages.get(tab), footer: '... 8100 pixels below - scroll to see more ...',
        tabId: tab, activeTabId: this.active, settled: true, capturedAt: '2026-09-10T00:00:00.000Z',
        tabs: [...this.pages.keys()].map(id => ({ id, url: `https://bench.test/${this.scenario.name}${id === 2 ? '/second' : ''}`, title: this.scenario.name, status: 'complete', active: id === this.active })),
      }
      return this.lastState
    }
    const indexes = [...(this.pages.get(tab) ?? '').matchAll(/\[(\d+)\]</g)].map(match => Number(match[1]))
    const requested = method === 'fill_fields' ? args.fields.map(field => field.index) : [args.index]
    if (requested.some(index => index !== undefined && !indexes.includes(index))) {
      this.actionFailures++
      return { success: false, message: 'Unknown element index' }
    }
    if (method === 'switch_to_tab') this.active = tab
    else if (method === 'close_tab') { this.pages.delete(tab); this.active = 1 }
    else if (this.scenario.popup && method === 'click_element' && tab === 1 && args.index === 0) {
      this.pages.set(2, this.scenario.after)
      this.active = 2
    } else if (method !== 'wait' && method !== 'find_element') {
      this.pages.set(tab, this.scenario.popup && tab === 1 ? this.scenario.before : this.scenario.after)
    }
    return { success: true, message: `${method} succeeded` }
  }

  kill() { this.emit('exit') }
}
