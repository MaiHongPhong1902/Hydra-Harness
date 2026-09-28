---
description: "在浏览器后台上传原始 Blob 与 ReadableStream，包括 Worker 转交、进度和取消。"
kind: "package-reference"
---

# @hydraharness/harness-client-file-upload

[English](README.md) | 中文

## 概述

本包让浏览器功能上传 `Blob` 或 `ReadableStream<Uint8Array>`，同时避免在页面线程聚合全部字节。普通服务页面通过专用 Worker 发送每个请求体；Host 位于其他执行上下文中的页面会在 Cordis 启动前提供 Fetch 形式的载体。调用方可以观察已消费字节并取消活动操作。stream 请求体只能消费一次，跨 Worker 边界时会转移所有权。独立的 `?fixture` 页面会报告后台载体不可用，让 Session adapter 继续使用生成的内存 Remote。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在注入 `fileUpload` 的消费方之前挂载 Client 插件，再用同源路径和一个原始请求体调用 `ctx.fileUpload.post()`。

```yaml
- id: file-upload
  name: '@hydraharness/harness-client-file-upload'
```

本包没有 Cordis 配置字段。`Blob` 在专用 Worker 内通过 XMLHttpRequest 发送，因此服务可以报告浏览器上传进度，并在浏览器提供总量时一并报告。`ReadableStream` 会转移给该 Worker，再增量传入 Fetch；进度只报告已消费字节，不包含总量。`AbortSignal` 会终止专用 Worker，或传递给页面自己提供的载体。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client 插件提供可被各级上下文继承的 `ctx.fileUpload` 服务。其提供方只读取一次可选的 Cordis 启动前 `__HYDRA_FILE_UPLOAD__` 钩子。消费者在选择服务前检查 `ctx.fileUpload.available`。没有该钩子时，每个非 fixture 请求拥有一个短期 Worker，并在完成、失败或取消后释放。存在该钩子时，服务通过页面自己提供的 Fetch 载体发送请求体；Web Worker runtime 会通过请求帧转移 stream 请求体，再以带背压的分片形式交给 Host HTTP bridge。

| 文件 | 职责 |
|---|---|
| [`src/client/contract.ts`](src/client/contract.ts) | Cordis 服务的请求、响应、进度与页面钩子类型 |
| [`src/client/runtime.ts`](src/client/runtime.ts) | 专用 Worker 与页面自有载体实现 |
| [`src/client/index.ts`](src/client/index.ts) | Client 插件注册与 `ctx.fileUpload` 声明 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Host API proxy](../../host/apiproxy/README.md)——认证的原始上传载体。
- [客户端组地图](../../README.md)——浏览器服务与 UI 功能包。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只传输浏览器请求体，不提供模型输入。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制适用于传输操作本身。

- **上传不能断点续传**：失败或取消后的重试会从第一个字节开始。
- **stream 请求体只能使用一次**：转移 `ReadableStream` 会锁定调用方的对象，因此重试必须重新创建 stream。
- **stream 进度没有总量**：stream API 不携带字节长度，因此调用方只能收到已消费字节数。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
