/** Generic clickable divs require the raw-text fallback. */
export const before = '[0]<div>Start</div>\n<div></div>\n[1]<div>More</div>'
export const after = '[0]<div>Start</div>\n<div></div>\n[1]<div>Done</div>'
export default { name: 'poor-accessibility', before, after, calls: [['browser_state', {}], ['browser_click', { index: 0 }], ['browser_find', { query: 'Done' }], ['browser_click', { index: 1 }]] }
