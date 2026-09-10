/** Small form, including the two-control order fixture's interaction pattern. */
export const before = '[0]<input name=user aria-label=User value=/>\n[1]<button>Sign in</button>'
export const after = '[0]<input name=user aria-label=User value=Ada/>\n[1]<button>Sign in</button>\nWelcome Ada'
export default {
  name: 'login', before, after,
  calls: [
    ['browser_state', {}],
    ['browser_fill', { fields: [{ index: 0, text: 'Ada' }] }],
    ['browser_click', { index: 1 }],
    ['browser_wait', { seconds: 1 }],
  ],
}
