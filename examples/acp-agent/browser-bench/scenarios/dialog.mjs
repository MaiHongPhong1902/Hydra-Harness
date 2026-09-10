/** A nested dialog replaces the underlying indexed controls. */
export const before = '[0]<button>Open dialog</button>\n[1]<a href=/help target=_blank>Help</a>\n<div inert></div>'
export const after = '<div role=dialog aria-label=Confirm>\n[0]<button aria-disabled=true>Confirm</button>\n[1]<button>Cancel</button>\n</div>'
export default { name: 'dialog', before, after, calls: [['browser_state', {}], ['browser_click', { index: 0 }], ['browser_find', { query: 'Cancel' }], ['browser_click', { index: 1 }]] }
