/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * module-table seeding, the boot page, and the UI-renderer handoff — lives
 * in @bosch/bh-client-web; this file only finds the mount point.
 */
import { AppWebEntry } from '@bosch/bh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
void new AppWebEntry(el).run()
