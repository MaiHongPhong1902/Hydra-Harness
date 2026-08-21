#!/usr/bin/env node

import { Context } from '@bosch/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@bosch/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@bosch/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
