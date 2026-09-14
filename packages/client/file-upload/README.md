---
description: "Background browser uploads for raw Blob and ReadableStream bodies, including worker transfer, progress, and cancellation."
kind: "package-reference"
---

# @hydra/harness-client-file-upload

English | [中文](README.zh.md)

## Summary

This package lets browser features upload a `Blob` or `ReadableStream<Uint8Array>` without aggregating its bytes on the page thread. Served pages send each body through a dedicated Worker; pages whose Host runs in another execution context supply a Fetch-shaped carrier before Cordis boots. Callers can observe consumed bytes and cancel an active operation. A stream body is consumed once and transfers ownership when it crosses a Worker boundary. The standalone `?fixture` page reports the background carrier as unavailable so its Session adapter can keep using the generated in-memory Remote.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the Client plugin before a consumer that injects `fileUpload`, then call `ctx.fileUpload.post()` with a same-origin path and one raw body.

```yaml
- id: file-upload
  name: '@hydra/harness-client-file-upload'
```

The package has no Cordis configuration fields. A `Blob` uses XMLHttpRequest inside a dedicated Worker so the service can report browser upload progress, including the total when the browser provides it. A `ReadableStream` transfers to that Worker and feeds Fetch incrementally; progress reports consumed bytes without a total. An `AbortSignal` terminates the dedicated Worker or reaches a page-owned carrier.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client plugin provides one inherited `ctx.fileUpload` service. Its provider reads the optional pre-Cordis `__HYDRA_FILE_UPLOAD__` hook once. Consumers inspect `ctx.fileUpload.available` before selecting it. Without a hook, each non-fixture request owns a short-lived Worker and releases it after completion, failure, or cancellation. With the hook, the service sends the body through the page-owned Fetch carrier; the Web Worker runtime transfers stream bodies through its request frame and exposes them to the Host HTTP bridge as backpressured chunks.

| File | Role |
|---|---|
| [`src/client/contract.ts`](src/client/contract.ts) | Cordis service request, response, progress, and page-hook types |
| [`src/client/runtime.ts`](src/client/runtime.ts) | Dedicated Worker and page-owned carrier implementations |
| [`src/client/index.ts`](src/client/index.ts) | Client plugin registration and `ctx.fileUpload` declaration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host API proxy](../../host/apiproxy/README.md) — the authenticated raw upload carrier.
- [Client packages](../README.md) — browser services and UI feature packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package transfers browser request bodies and contributes no model input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the transport operation itself.

- **Uploads are not resumable** — a failed or cancelled retry starts from the first byte.
- **Stream bodies are one-shot** — transferring a `ReadableStream` locks the caller's object, so retry requires a newly created stream.
- **Stream progress has no total** — callers receive consumed-byte counts because the stream API carries no byte length.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
