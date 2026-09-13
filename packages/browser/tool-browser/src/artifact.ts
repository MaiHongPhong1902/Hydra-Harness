/** Private browser output files; filenames never select a workspace write. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Validate a suggested output filename before browser work begins.
 * @param filename - single filename inside a newly allocated private directory.
 */
export function validateFilename(filename: string): void {
  if (!filename.trim() || filename.length > 200 || filename !== basename(filename)
    || /[\\/:*?"<>|\u0000-\u001f]/u.test(filename) || /[. ]$/u.test(filename)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(filename)) {
    throw new Error('filename must be a plain filename without directories or reserved characters')
  }
}

/**
 * Save an artifact without overwriting another call's output.
 * @param directory - deployment-owned output directory.
 * @param filename - validated single filename.
 * @param data - complete UTF-8 text or encoded image bytes.
 * @param signal - cancellation before and during writing.
 * @returns absolute path of the saved artifact.
 */
export async function saveBrowserArtifact(
  directory: string, filename: string, data: string | Uint8Array, signal: AbortSignal,
): Promise<string> {
  validateFilename(filename)
  signal.throwIfAborted()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const privateDirectory = await mkdtemp(join(directory, 'capture-'))
  const path = join(privateDirectory, filename)
  try {
    await writeFile(path, data, { flag: 'wx', mode: 0o600, signal })
  } catch (error) {
    await rm(privateDirectory, { recursive: true, force: true })
    throw error
  }
  return path
}
