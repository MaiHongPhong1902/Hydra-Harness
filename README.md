# Hydra harness

Hydra harness (`bh`) is an open-source agent harness based on [Bosch Harness](https://github.com/bosch/bosch-harness), originally developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

Hydra harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @hydra/harness web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone --recurse-submodules https://github.com/bosch/bosch-harness.git
cd bosch-harness
pnpm install
pnpm run build
pnpm bh web
# for desktop:
pnpm run desktop
```

`pnpm install` needs the PageAgent git submodule on disk. Clone with `--recurse-submodules`, or follow [Checking out PageAgent](packages/browser/browser-electron/README.md#checking-out-pageagent) if install reports `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` for `@page-agent/core` or `@page-agent/page-controller`. `pnpm run build` prepares the repository artifacts through the workspace `tsx`; `pnpm bh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/bosch/bosch-harness/discussions).
- Add the [`bh-plugin`](https://github.com/topics/bh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">Bosch Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
