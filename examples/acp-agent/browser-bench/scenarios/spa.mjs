/** A long run changes a small status region while the controls remain usable. */
export const before = [
  '[0]<button aria-expanded=false>Refresh</button>',
  ...Array.from({ length: 50 }, (_, i) => `[${i + 1}]<a href=/record/${i}>Record ${i}</a>`),
  '<div role=presentation></div>', '<div></div>', 'Status: pending',
].join('\n')
export const after = before.replace('Status: pending', 'Status: complete')
export default {
  name: 'spa', before, after,
  calls: [['browser_state', {}], ...Array.from({ length: 30 }, (_, i) => i % 5 === 4 ? ['browser_state', {}] : ['browser_click', { index: 0 }])],
}
