# Use the desktop app

Hydra Desktop is a Windows-first Electron shell around the same Hydra Host and Web renderer. The bare `npx @hydraharness/harness` menu lists Desktop so users can find this workflow, but selecting it does not launch Electron: the repository does not publish an installer, supported npm Desktop artifact, or an `npx` desktop command. Desktop runs from a source checkout during the developer preview.

## Prerequisites

Install Node.js **22.19 or later in the 22.x line, or 24 and newer**, Git, and pnpm. The desktop browser includes its locally owned BrowserAgent source.

## Build and launch

From the repository root, run:

```sh
git clone https://github.com/MaiHongPhong1902/Hydra-Harness.git
cd Hydra-Harness
pnpm install
pnpm run build
pnpm run desktop
```

The desktop process starts the Web profile internally on a local loopback port and loads it in one Electron window. It does not open a second browser window. Run `pnpm run build` again after source changes before launching the desktop app.

## Start a task

Open **Settings → Models** and configure a provider, then choose a workspace and start a session. The model and workspace setup is the same as the [Web UI quickstart](./index.md), and the [model guide](./providers.md) covers DeepSeek, catalog providers, and custom endpoints.

The desktop window includes the conversation UI, the controlled browser, terminal sessions, and workspace files. These panels share the selected session and workspace while the Host keeps their permissions and approvals.

## Data location

Desktop-specific Electron data is stored below `$HYDRA_HOME/desktop-electron`. When `HYDRA_HOME` is not set, Hydra uses `~/.hydra` as the home directory.

## Troubleshooting

- **`Desktop Host is not built`** — run `pnpm run build` from the repository root, then run `pnpm run desktop` again.
- **BrowserAgent package errors during install** — confirm the tracked `packages/browser/browser-electron/third-party/browseragent` source is present, then run `pnpm install` again.
- **You want a downloadable installer** — packaging, signing, and auto-update are not available in the current developer preview; use the source launch above.

## Continue

- [Use the Web UI](./index.md)
- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
