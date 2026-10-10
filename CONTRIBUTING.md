# Contributing to Pockode

Thanks for helping make Pockode better.

## Ways to contribute

- **Bug reports and feature ideas** — [open an issue](https://github.com/sijiaoh/pockode/issues).
- **Questions and open-ended ideas** — start a thread in [Discussions](https://github.com/sijiaoh/pockode/discussions).
- **Documentation fixes** — send a pull request directly.
- **Small code fixes** — send a pull request directly.
- **Larger code changes** — open an issue first so we can agree on the approach before you invest the time.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Contributor License Agreement

Every pull request needs a signed [CLA](CLA.md). The CLA bot comments on your first pull request; reply with the sentence it gives you and you are done.

## Development

The project layout and conventions are in [AGENTS.md](AGENTS.md). Commands live with the code they run:

| Area | Where |
| ---- | ----- |
| Go server (run, test, `gofmt`, `go vet`) | [server/AGENTS.md](server/AGENTS.md) |
| Web frontend (dev, test, type check) | [web/AGENTS.md](web/AGENTS.md) |
| README, website and marketing copy | [site/README.md](site/README.md#where-the-words-come-from) |
| Lint and format (all frontends) | `pnpm run lint` / `pnpm run format` from the repository root |
| Why a test is red | [docs/testing.md](docs/testing.md) |

Run `pnpm install` once, then `POCKODE_PASSWORD=<any-password> pnpm run dev` starts the server and the web frontend together (the server refuses to start without a password). On Windows, develop under WSL — see [docs/platforms.md](docs/platforms.md#developing-pockode-on-windows).

Before opening a pull request, make sure lint, format and the tests for the code you touched pass. CI runs the same checks.

## Pull requests

- Keep one pull request to one change.
- Write commit messages that say what was done.
- Update the docs in `docs/` when you change the behavior they describe.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
