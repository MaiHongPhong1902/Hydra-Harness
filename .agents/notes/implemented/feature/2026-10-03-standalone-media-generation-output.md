# Agent Note: Standalone media generation output

Status: implemented

## Problem

Generated media is a user deliverable. Rendering it inside tool activity disclosures ties its visibility to execution chrome and gives a pending generation no consistent presentation. Images and videos also need durable references rather than provider URLs.

## Decision

Tools declare `card: 'media'` with an image/video kind and authored prompt. Their results carry durable artifact references and actual provider/model labels. The existing Tool conversation definition preserves its context key, call/result pairing, interruption handling, and compatibility history while dispatching these calls as `media-generation` Nodes. Non-tool Nodes are activity-group boundaries, so the dedicated renderer remains visible independently of tool disclosures.

The renderer uses a CSS pending animation, settled failure or interruption, the shared image gallery, and native video controls without autoplay. Reduced-motion disables animation. Inspection remains available through the existing trajectory callback; Payload and Result are selectable with copy controls, and the authored prompt has a direct copy action. Captions and composer generation rows show only the model name, retaining the ID when the catalog or model is unavailable. Captions resolve the actual generated model through its provider catalog; provider identity remains in the recorded result and grouped selector choices. There is no elapsed percentage because provider progress is unavailable.

Known requested dimensions set a positive call-time `aspectRatio`; automatic dimensions leave it unspecified. Generated galleries preserve every image's stored width/height ratio instead of using the cropped message-thumbnail treatment, including batches and extreme ratios. Generated images and pending previews fill the card width, allowing small originals to upscale so the deliverable uses the available space. Video controls retain their intrinsic ratio. Loading images reserve their final space, and narrow panes reduce width without stretching or cropping. Real Web replay covers portrait and panoramic provider responses, requested pending ratios, native video geometry, model names, clipboard writes, and history reload.

Videos extend stored file references with MP4/WebM MIME. Producers own video admission and save final bytes before logging `tool-videos` metadata. Session authorization verifies each reference before reading stored bytes, and export includes exact files. The host reconstructs successful media views from durable metadata even without the original tool or call arguments. Model history retains only the tool's acknowledgement or error.

The [image generation decision](2026-10-02-openai-image-generation.md) retains provider credentials, billing, final-batch admission, and Native-only dispatch rules. The [attachment decision](2026-07-22-web-multimodal-image-input-and-durable-attachments.md) retains immutable storage and authorized reads. Neither is fully superseded.

## Alternatives considered

**Keep media inside an expanded tool stack.** Rejected because the deliverable still disappears when execution details collapse.

**Route by provider or tool names.** Rejected because the media render intent applies to every producer and preserves one treatment across providers.

**Store provider URLs or pixels in the transcript.** Rejected because URLs expire and byte payloads duplicate the attachment store.

## Consequences

The agent loop and model-visible event formats are unchanged. Real Web replay exercises running/error states, image preview, video playback, download, reload, and export through stored bytes. Provider video submission/polling remains a separate Consumer. The attachment RPC buffers video bytes; a streamed route is required for large provider outputs.
