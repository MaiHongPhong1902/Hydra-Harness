/** A long table whose next viewport exposes the following rows. */
const rows = start => Array.from({ length: 120 }, (_, i) => `Row ${start + i}: Inventory item, warehouse west, available quantity 100`).join('\n')
export const before = `[0]<button>Next</button>\n${rows(0)}`
export const after = `[0]<button>Next</button>\n${rows(120)}`
export default {
  name: 'table', before, after,
  calls: [['browser_state', {}], ['browser_scroll', { down: true }], ['browser_find', { query: 'Next' }], ['browser_click', { index: 0 }], ['browser_state', {}]],
}
