/** Browser request body accepted by the background file-upload service. */
export type FileUploadBody = Blob | ReadableStream<Uint8Array>

/** Monotone byte progress reported while a browser body is consumed. */
export interface FileUploadProgress {
  readonly loaded: number
  readonly total?: number
}

/** One background upload request. */
export interface FileUploadRequest {
  readonly path: string
  readonly body: FileUploadBody
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: FileUploadProgress) => void
}

/** Small response returned after the service has sent the body. */
export interface FileUploadResponse {
  readonly status: number
  readonly body: string
}

/** Browser upload service inherited by every Client Cordis scope. */
export interface FileUploadService {
  /** Whether this page has a Host-backed background upload carrier. */
  readonly available: boolean
  /**
   * Post one Blob or one-shot byte stream without aggregating it on the page thread.
   * The call consumes a stream body and rejects with `AbortError` when its signal fires.
   * @param request - target, body, cancellation, and progress observer.
   * @returns the response status and text body.
   */
  post(request: FileUploadRequest): Promise<FileUploadResponse>
}

/**
 * Fetch-shaped carrier installed by a page that owns its Host transport.
 * @param input - absolute same-origin upload URL.
 * @param init - raw request body, headers, and cancellation signal.
 * @returns the Host response.
 */
export type FileUploadFetch = (input: URL, init: RequestInit) => Promise<Response>

/** Pre-Cordis hook supplied by a page whose Host runs in another execution context. */
export interface ClientFileUploadHooks {
  readonly fetch: FileUploadFetch
}
