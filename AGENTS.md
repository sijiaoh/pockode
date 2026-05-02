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
├── web/            # React frontend (see web/AGENTS.md)
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

### Code Style

- Frontend: Use Biome (Linter + Formatter), follow React best practices (see web/AGENTS.md)
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
