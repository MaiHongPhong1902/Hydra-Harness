// @ts-check
// Applies Hydra's PageAgent patch for Vite without changing the submodule's files or index.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePath } from 'vite'

/**
 * Load patched source from an isolated Git index; reject conflicting local edits.
 * @param {string} sourceDir Absolute path to the initialized PageAgent submodule.
 * @param {string} patchPath Absolute path to Hydra's tracked patch.
 * @returns {import('vite').Plugin} Source loader preserving TypeScript and CSS module transforms.
 */
export function pageAgentPatch(sourceDir, patchPath) {
  /** @type {Map<string, string>} */
  const sources = new Map()
  return {
    name: 'page-agent-patch',
    enforce: 'pre',
    buildStart() {
      sources.clear()
      const temporary = mkdtempSync(join(tmpdir(), 'hydra-page-agent-'))
      /** @param {string[]} args Git arguments against the build's private index. */
      const git = (args) => execFileSync('git', args, {
        cwd: sourceDir, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') },
      })
      try {
        git(['read-tree', 'HEAD'])
        git(['apply', '--cached', patchPath])
        for (const file of git(['diff', '--cached', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)) {
          const patched = git(['show', `:${file}`])
          const current = readFileSync(join(sourceDir, file), 'utf8').replace(/\r\n/g, '\n')
          if (current !== patched && current !== git(['show', `HEAD:${file}`])) {
            throw new Error(`PageAgent patch conflicts with local edits in ${file}; update page-agent.patch first`)
          }
          // Vite can retain Windows short names or resolve a symlink to its physical path.
          sources.set(normalizePath(join(sourceDir, file)), patched)
          sources.set(normalizePath(realpathSync.native(join(sourceDir, file))), patched)
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true })
      }
    },
    load(id) {
      return sources.get(normalizePath(id.replace(/\?.*$/u, '')))
    },
  }
}
