/** Browser-owned text edit admission; attachments remain unchanged. */

/** Exact draft sent by the inline editor; the key survives retry while its contents stay unchanged. */
export interface PromptEditOptions {
  idempotencyKey: string
}
