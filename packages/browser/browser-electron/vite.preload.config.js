// @ts-check
// Bundles `electron-app/preload.entry.js` and the upstream PageAgent engine
// into ONE self-contained CommonJS file, `electron-app/preload.cjs`.
//
// One file is not a preference: a preload running with `sandbox: true` has no
// module resolver. Its `require` is a stub that serves `electron` and a few node
// builtins and nothing else, so every other import must be inlined. `electron`
// stays external for exactly that reason.
//
// The output is committed. This config runs only when the vendored source or
// entry changes. The PageAgent Panel stays excluded. The entry applies mask
// styles as a constructed stylesheet because a sandboxed preload cannot load
// Vite's emitted CSS asset.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { pageAgentPatch } from './page-agent-patch.js'

const here = dirname(fileURLToPath(import.meta.url))
const pageAgent = resolve(here, 'third-party/page-agent')
const patch = resolve(here, 'page-agent.patch')

export default defineConfig({
  clearScreen: false,
  esbuild: { tsconfigRaw: { compilerOptions: { target: 'esnext' } } },
  plugins: [pageAgentPatch(pageAgent, patch), {
    name: 'discard-external-page-agent-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') output.code = output.code.replace(/[ \t]+$/gmu, '')
        // The only required CSS is imported with `?inline` by preload.entry.js.
        // Its regular PageController import still emits this unusable duplicate.
        if (output.type === 'asset' && fileName.endsWith('.css')) delete bundle[fileName]
      }
    },
  }],
  publicDir: false,
  build: {
    // PageAgent's package tsconfig targets `es2025`, which the current esbuild
    // does not name yet. Electron runs a current Chromium, so `esnext` is the
    // equivalent bundle target without per-source warnings.
    target: 'esnext',
    lib: {
      entry: resolve(here, 'electron-app/preload.entry.js'),
      fileName: () => 'preload.cjs',
      formats: ['cjs'],
    },
    outDir: resolve(here, 'electron-app'),
    emptyOutDir: false,
    rollupOptions: {
      external: ['electron'],
      // PageController's optional mask is dynamically imported. Inline it
      // because the sandboxed preload cannot load a second chunk.
      output: { inlineDynamicImports: true },
      // Upstream's DOM walker mentions `eval` in its own guard; the warning is
      // upstream's business, not a signal about this bundle.
      onwarn: (message, handler) => {
        if (message.code === 'EVAL') return
        handler(message)
      },
    },
  },
  define: { 'process.env.NODE_ENV': '"production"' },
})
