/** A popup is adopted, inspected, closed, and followed by a return to tab one. */
export const before = '[0]<a href=https://bench.test/second target=_blank>Open details</a>\n[1]<button>Continue</button>'
export const after = '[0]<button>Details loaded</button>\n[1]<a href=https://bench.test/multi-tab>Return</a>'
export default { name: 'multi-tab', before, after, popup: true, calls: [['browser_state', {}], ['browser_click', { index: 0 }], ['browser_switch_tab', { tab_id: 2 }], ['browser_click', { index: 0, tab_id: 2 }], ['browser_close_tab', { tab_id: 2 }], ['browser_click', { index: 1, tab_id: 1 }]] }
