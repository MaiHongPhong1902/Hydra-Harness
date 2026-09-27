import { describe, expect, it } from 'vitest'
import { codeBlockKind, decorateFenceHtml, normalizeCommand } from '../website/.vitepress/code-blocks.ts'

describe('website code block presentation', () => {
  it('classifies executable fences and explicit output fences', () => {
    expect(codeBlockKind('sh')).toBe('command')
    expect(codeBlockKind('powershell')).toBe('command')
    expect(codeBlockKind('output')).toBe('output')
    expect(codeBlockKind('text output')).toBe('output')
    expect(codeBlockKind('ts')).toBeUndefined()
  })

  it('removes shell prompts without changing command lines', () => {
    expect(normalizeCommand('$ npm install\nPS C:\\repo> pnpm run build\n> npm start\nconfig.json')).toBe('npm install\npnpm run build\nnpm start\nconfig.json')
  })

  it('decorates commands with a labelled copy button', () => {
    const html = decorateFenceHtml('<div class="language-sh vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">sh</span></div>', 'command')
    expect(html).toContain('hydra-command-block')
    expect(html).toContain('aria-label="Copy command to clipboard"')
    expect(html).toContain('title="Copy command"')
  })

  it('removes copy controls from terminal output', () => {
    const html = decorateFenceHtml('<div class="language-output vp-adaptive-theme"><button title="Copy Code" class="copy"></button><span class="lang">output</span></div>', 'output')
    expect(html).toContain('hydra-output-block')
    expect(html).not.toContain('class="copy"')
  })
})
