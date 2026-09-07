# bundle/ — profile plugin bundles

Profile bundles: npm packages whose manifest declares `"hydra": { "bundle": { "patch": "./cordis.patch.yml" } }`, making them installable patch layers for `hydra --profile` compositions ([profile contract](../boot/app-boot/README.md#profiles)). A bundle's substance is its patch list; some also ship runtime glue plugins their patch mounts.

The manifest declaration, not this directory, defines Bundle identity. Domain packages can carry their own optional Profile layer; the [Codex and Claude Code subagent packages](../subagent/README.md) are directly installable examples.

| Package | Role | ctx key |
|---|---|---|
| [`base/`](base/README.md) | The shared hydra core every profile applies first | — (patch only) |
| [`web-app/`](web-app/README.md) | Browser surface: web patch layer + runtime glue plugin | mounts rows |
| [`headless/`](headless/README.md) | Direct one-shot task mode over base, with no Host or Web layer | mounts `headless-runner` |

In-box bundles resolve from the hydra installation; out-of-tree bundles install into a profile through `hydra plugin --profile <name> add <package>`.
