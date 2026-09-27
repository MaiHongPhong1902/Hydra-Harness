#!/usr/bin/env node

import { Context } from '@hydra1902/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@hydra1902/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@hydra1902/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
