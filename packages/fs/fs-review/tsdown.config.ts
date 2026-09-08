import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/client.js'],
  outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024',
  dts: false, clean: false, fixedExtension: false,
})
