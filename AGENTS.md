# Pockode

You are a world-class full-stack engineer specializing in mobile AI programming platform development with React + Go.

## Project Overview

Pockode is a mobile programming platform with the core philosophy of "AI editing first, manual editing second." Users interact with AI through natural language to complete development work, rather than operating a traditional editor on a small screen.

## Tech Stack

| Layer    | Technology                 |
| -------- | -------------------------- |
| Frontend | React + Vite + Tailwind    |
| Backend  | Go                         |
| Comm     | WebSocket JSON-RPC 2.0 ([design](docs/websocket-rpc-design.md)) |
| AI Calls | CLI subprocess (not SDK binding) |

## Project Structure

```
pockode/
├── packages/       # Shared frontend packages (pnpm workspace)
│   └── shared/     # Shared components, hooks, stores, and utilities
├── web/            # React frontend (see web/AGENTS.md)
├── web-cluster/    # Cluster mode frontend (lightweight, see docs/cluster.md)
├── server/         # Go backend (see server/AGENTS.md)
├── site/           # pockode.com website (Hugo)
└── docs/           # Design documents (entry: docs/concept.md)
    └── code/       # Code explanation docs (see docs/code/AGENTS.md)
```

## Architecture Overview

```
React SPA (Frontend)
        │ WebSocket
        ▼
   Go Service (Backend)
        │ spawn + stream-json
        ▼
   AI CLI (claude / codex / ...)
```

## Development Guidelines

### Code Organization

- **Locate before you code** — Determine where code belongs before writing it; especially for reusable logic, proper placement enables discovery and reuse
- **Everything in its place** — Utility functions go in utility modules, business logic goes in business modules, follow the existing project structure
- **Events are events, state is state** — An event record is immutable history: it says what was true at one moment. Live state belongs to the store that owns it. Never put state into an event record, and never read current state back out of one — the record cannot change when the state does, so it starts lying (worked example: [docs/code/work-system.md](docs/code/work-system.md#work-messages-in-chat))

### Shared Code (`@pockode/shared`)

The `packages/shared` package contains UI components, hooks, stores, and utilities shared between `web` and `web-cluster` projects via pnpm workspace.

**When to add code to shared**:
- Component or hook is **identical or near-identical** in both projects
- Code is **stable** (not under active experimentation)
- Code has **no project-specific dependencies** (peer dependencies: React, ReactDOM, Zustand)

**When NOT to share**:
- Code has **significant behavioral differences** between projects
- Code is **tightly coupled** to project-specific features
- Code is **experimental** or likely to diverge

**Available exports**:
- Components: `Spinner`, `ConfirmDialog`, `Sheet`, `ReconnectBanner`
- Hooks: `useMediaQuery`, `useOutsideClick`, `useIsExpanded`, `useHasCoarsePointer`, `useHasFinePointer`
- Stores: `createAuthStore` (factory function for the auth store, with configurable localStorage keys)
- Utils: `getWebSocketUrl`, `BREAKPOINTS`, `MEDIA_QUERIES`, `hasCoarsePointer`, `credentialParams` / `authFailureReason` (the `auth` RPC contract both frontends share with the server — see [docs/code/authentication.md](docs/code/authentication.md))
- `@pockode/shared/vitest`: `vitestRuntimeOptions` — the worker and timeout settings both `vitest.config.ts` files spread in. A separate subpath because it needs Node types, which the browser entry must not pull in; it lives outside `src` for the same reason. It is the one plain-JavaScript file here: vite leaves a config's bare imports external, so Node loads this one itself, and the Node that `.node-version` pins cannot read `.ts`.

These components carry Tailwind classes, which puts two obligations on the
projects rather than on this package: each stylesheet has to name
`packages/shared/src` in an `@source` (automatic source detection stops at the
project directory and never enters the workspace link), and each has to declare
every project `@utility` a shared component uses — today `touch-target`. Both
failures are silent: the class stays on the element and compiles to nothing, in
one project while the other is fine. `web/tests/sourceScan.test.ts` and
`web/tests/responsiveTokens.test.ts` hold both.

`useLockBodyScroll` is deliberately *not* exported: it is one counter shared by
`Sheet` and `ConfirmDialog` so that two overlays unmounting together cannot
restore each other's `overflow` and leave the page permanently unscrollable.
Anything in this package that covers the page uses it; exporting it would invite
a third, separate counter, which is the bug itself.

`useOutsideClick` hands its callback the event beside the target, and an overlay
with no backdrop of its own has to `stopPropagation` on the press it closes on:
without a backdrop that press carries on to whatever is behind, which may read a
press there as its own dismissal too, so one press puts away two panels. Only
the caller knows a click was a dismissal at all — and only on the press it
actually closes on, since a click it lets through is not its to take — so
claiming has to be the caller's; the hook filters nothing. The convention, and
which surfaces are exposed to it, live in
[docs/answering-ui.md](docs/answering-ui.md#who-owns-the-dismissing-click).

The responsive exports are the single source for the width ladder and the two
pointer gates; both stylesheets are checked against them. Width decides where
things go, pointer decides whether they can be reached — see
`packages/shared/src/utils/responsive.ts`.

**Usage**:
```typescript
import { Spinner, ConfirmDialog, useIsExpanded, createAuthStore, getWebSocketUrl } from "@pockode/shared";
```

**Workflow**:
1. Add shared code to `packages/shared/src/`
2. Export from appropriate index file
3. Run `pnpm install` to link workspace
4. Import in consumer projects

### Code Style

- Frontend: Use Biome (Linter + Formatter), follow React best practices (see web/AGENTS.md)
    - Biome runs from the repository root — `pnpm run lint` / `pnpm run format` cover
      `web`, `web-cluster` and `packages` in one pass, so `packages/shared` (which ships
      inside both frontends) is not left to a project that does not own it. The root
      `biome.json` holds the settings; each project's `biome.json` is `extends: "//"`
      plus only what genuinely differs. The three directories are named rather than
      passing `.`, because a root-level sweep walks into `site/` — Biome panics on
      Hugo's Go templates — and into data files such as `signatures/version1/cla.json`
      that it has no business reformatting. `format` is `biome check --write` with the
      linter off, not `biome format`: import order is an assist action, so plain
      `biome format` leaves a failure that `lint` reports and cannot fix itself.
    - The projects deliberately have no `lint` / `format` script of their own. A
      forwarding script would quietly check the *other* frontend too, so instead
      `pnpm run lint` inside `web/` fails with `Missing script: lint` — and pnpm's
      own error already names `pnpm -w run lint`, which is the answer anyway.
- Backend: Use `gofmt`, follow idiomatic Go
- Run linter and formatter before committing

### Comment Guidelines

- **Use English** — All code comments, TODOs, and docstrings must be in English
- **Only write what code cannot express** — Function names, types, and code structure usually don't need comments
    - ❌ Describe what code does (What) — The code already says this (except for overly complex or unusual logic)
    - ✅ Explain why it's done this way (Why) — Design decisions, non-obvious reasoning
    - ✅ Describe when to use it (When) — If usage scenarios aren't self-evident
    - ✅ Document where values come from (Where) — Magic numbers, external dependency connections
- **Avoid noise** — Self-evident comments and redundant descriptions of types/function names are noise
- **Keep in sync** — Outdated comments are worse than none; update comments when changing code
- **TODOs need context** — e.g., `// TODO: Remove after upstream API supports X`
- **Design docs go in docs/** — System-level architecture explanations don't belong in code comments

### Public Repository Boundary

This repository is public; the cloud service it connects to is developed in a separate private repository. Everything written here — code, comments, docs, commit messages — is published.

- **Never disclose the private repository's internals** — its file paths, file names, design document names, directory layout, or internal technology choices (which edge proxy, which database, ...). They are worthless to a reader who cannot open them, and they expose the closed-source layout.
- **Do document the interoperability contract** — transport protocol, authentication scheme, timeout and grace-period values, compression negotiation. Anyone self-hosting the other side needs these facts, and they are the reason the constants here have the values they do.
- **Refer to the other side neutrally** — "the cloud's relay implementation", "the cloud's relay design document", "the cloud's tunnel grace period". Keep the fact and the number, drop the path.

### Git Guidelines

- **Do not use the `-C` option**
- Branch naming: `feature/xxx`, `fix/xxx`, `refactor/xxx`
- Commit messages should be concise and clear, describing "what was done" not "how it was done"
- Keep commit granularity reasonable, one commit does one thing

### Testing

- **Follow the testing pyramid** — Many unit tests > some integration tests > few E2E tests; lower-level tests should be more numerous, faster, and more stable
- **Test specifications, not coverage** — The purpose of testing is to verify behavioral contracts, not to blindly increase coverage numbers
- **Don't test trivial code** — Simple getters, constructors, and single-line delegation methods don't need tests
- **Test public interfaces** — Testing public methods naturally covers internal implementation, no need to separately test private methods
- **Keep it lean** — Each test should have a clear purpose; redundant tests are a burden, not an asset
- Ensure tests pass before committing
- **A red test is a diagnosis, not a verdict** — Before assuming the code broke, tell apart a contended machine, a timing assumption, a fabricated state, and a test that silently never ran; [docs/testing.md](docs/testing.md) has the checks, the timeout knobs, how to reproduce a macOS- or Windows-only failure on Linux, the two suites neither test entry point runs (one of them spends real money per turn), and which "passing" commands check nothing

### Error Handling

- **No silent failures** — All errors must be reported to users; users are developers who need to know what's happening
- **Provide meaningful error messages** — Error messages should include enough context to help locate problems
- **Distinguish user errors from system errors** — User operation errors get guidance, system errors get technical details
- **Don't over-defend** — Trust the type system and internal data; only validate at system boundaries

## AI Assistant Guidelines

1. **Think in English, communicate in user's language** — Use English for internal reasoning for better logic, but communicate with users in their language
2. **Read existing code first** — Understand context before making changes
3. **Just-right design** — Design well within current requirements with clear structure and thorough consideration; but don't do speculative development beyond requirements
4. **Follow existing patterns** — Stay consistent with the project's existing code style
5. **Don't reinvent the wheel** — Reuse existing components and utility functions
6. **Security first** — Mind OWASP Top 10, avoid introducing security vulnerabilities
7. **Never edit generated files directly** — Files like `pnpm-lock.yaml`, `go.sum` and other lock files must be generated or updated through proper commands (`pnpm install`, `go mod tidy`)
8. **DRY principle** — Follow The Pragmatic Programmer philosophy; code, tests, and documentation should have no duplication; every piece of knowledge should have a single, unambiguous representation in the system
9. **Step back and see the big picture** — Don't blindly fix problems; first consider the root cause and whether the design is sound, then decide on action
10. **Follow best practices** — Be aware of and follow industry best practices in all work
11. **Keep code explanation docs in sync** — When modifying core modules (WebSocket, Agent, Work, Subscription, Relay), check if `docs/code/` needs updating

## References

**Reference projects** (clone to `./refs/` as needed):

- [happy](https://github.com/slopus/happy) — Schema and implementation reference
- [claude-code-chat](https://github.com/andrepimenta/claude-code-chat) — stream-json implementation reference
- [anthropic-sdk-go](https://github.com/anthropics/anthropic-sdk-go) — API type definition reference

**Schema reference**: [Claude Agent SDK](https://platform.claude.com/docs/en/api/agent-sdk/typescript) — Authoritative definition for stream-json message structure
