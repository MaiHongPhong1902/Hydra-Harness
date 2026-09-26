---
layout: false
---

# Hydra harness

Hydra is an open-source agent workspace for running useful AI work across the Web UI, desktop app, and command line.

Give an agent a workspace, a model, and the permissions it needs. Hydra keeps the session, tools, approvals, and extensions in one plugin-based runtime.

[Start with the Web UI](./guide/index.md) · [Configure a model](./guide/providers.md) · [Read the architecture](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/docs/architecture.md)

## Run Hydra

### From npm

```sh
npx @hydra/harness web
```

The Web UI starts at `http://127.0.0.1:3080`. Use `--no-open` when the browser should not open automatically.

### From source

```sh
git clone --recurse-submodules https://github.com/MaiHongPhong1902/Hydra-Harness.git
cd Hydra-Harness
pnpm install
pnpm run build
pnpm hydra web
```

For one headless task, run `pnpm hydra --profile headless "summarize this repository"`.

## What Hydra can do

### Build and operate agents

- Run the same agent runtime through the Web UI, desktop app, CLI, ACP, JSON-RPC, or Python SDK.
- Choose a workspace, model provider, permission policy, and profile for each task.
- Start, resume, fork, query, title, and inspect durable sessions.
- Stream model responses with token usage, context management, compaction, and system-prompt assembly.

### Work directly in projects

- Read, write, review, diff, and undo files with workspace ownership and file locking.
- Run Bash, PowerShell, subprocesses, persistent PTY terminals, background jobs, and code-runtime tasks.
- Navigate code with language servers and compose project-specific skills.
- Use plans, goals, todos, human commands, and user questions to keep long tasks understandable.

### Use the browser and the web

- Open and control browser pages from the desktop browser integration.
- Navigate, click, type, select, scroll, upload, inspect pages, and capture screenshots.
- Search and fetch web content through the web capability.
- Keep browser actions behind host permissions and the configured interaction policy.

### Keep context across work

- Reconstruct model-visible work from the durable session event log.
- Resume after interruptions and fork a session when a task needs a separate direction.
- Compact long conversations while preserving the active task context.
- Store workspace, settings, credentials, page memory, and spill data through their owning plugins.

### Coordinate work

- Delegate work to subagents and collect their results in the parent session.
- Run workflows, scheduled reminders, and background jobs from the same capability system.
- Expose Hydra through the Web server, ACP automation server, JSON-RPC, TypeScript clients, and the Python SDK.
- Build repeatable profile bundles for Web, headless, and custom deployments.

### Control access and execution

- Require approvals for sensitive actions and select reusable permission presets.
- Apply sandbox and process policies to shells, subprocesses, files, and browser actions.
- Keep credentials in the credential capability instead of browser state or prompts.
- Fail closed when configuration, capability ownership, or durable data is invalid.

### Extend the runtime

Every product feature is a plugin. Add or replace model providers, tools, services, storage, UI modules, skills, workflows, hooks, and capability providers through Cordis composition and profile patches.

[Create your first plugin](./develop/basic/index.md) · [Build a tool](./develop/basic/tool.md) · [Configure a plugin](./develop/basic/config.md) · [Package and install it](./develop/basic/publish.md)

## Choose a starting point

| You want to… | Start here |
| --- | --- |
| Run an agent in a browser | [Web UI quickstart](./guide/index.md) |
| Connect DeepSeek or another endpoint | [Model providers](./guide/providers.md) |
| Run a task from CI or a terminal | [CLI reference](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/apps/cli/README.md) |
| Automate Hydra from Python | [Python SDK](./guide/python-sdk.md) |
| Understand the runtime | [Architecture](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/docs/architecture.md) |
| Explore every capability package | [Package map](https://github.com/MaiHongPhong1902/Hydra-Harness/blob/main/packages/README.md) |
| Add a feature | [Plugin development](./develop/basic/index.md) |

## First task

1. Open **Settings → Models** and configure a provider.
2. Select **Choose workspace** and add a project directory.
3. Start a session and ask: **“Summarize this repository and identify its main packages.”**

Hydra is a developer preview. APIs, configuration, and stored data can change while the foundation is being built.
