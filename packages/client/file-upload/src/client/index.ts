/** Browser background-upload Cordis service. */

import type { Context } from '@hydra1902/cordis'
import { FileUploadRuntime } from './runtime.ts'

export type {
  ClientFileUploadHooks,
  FileUploadBody,
  FileUploadFetch,
  FileUploadProgress,
  FileUploadRequest,
  FileUploadResponse,
  FileUploadService,
} from './contract.ts'

declare module '@hydra1902/cordis' {
  interface Context {
    /** Browser service for non-aggregating Blob and byte-stream uploads. */
    fileUpload: import('./contract.ts').FileUploadService
  }
}

/** This transport service has no Cordis dependencies. */
export const inject: string[] = []

/**
 * Provide the browser background-upload service.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FileUploadRuntime)
}
