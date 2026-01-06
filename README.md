# Pockode

[![Server](https://github.com/sijiaoh/pockode/actions/workflows/server.yml/badge.svg)](https://github.com/sijiaoh/pockode/actions/workflows/server.yml)
[![Web](https://github.com/sijiaoh/pockode/actions/workflows/web.yml/badge.svg)](https://github.com/sijiaoh/pockode/actions/workflows/web.yml)

**Code from anywhere with Claude Code.**

Ever wanted to fix a quick bug from your phone? Or push that feature while waiting for coffee? Pockode makes it happen — a mobile-first interface for Claude Code that lets you code from literally anywhere.

<!-- TODO: Add demo gif here -->

## Why Pockode?

Mobile coding has always sucked. Tiny screens, awkward keyboards, clunky editors... Traditional tools try to squeeze desktop IDEs into your phone. That's the wrong approach.

Pockode flips the script: **talk to AI, not to your keyboard.**

- 💬 Describe what you want in natural language
- 🤖 Claude Code does the heavy lifting
- ✅ You review and ship

No more fat-finger typos. No more hunting for that semicolon. Just conversations that turn into code.

## Features

🗣️ **Conversational Coding** — Write, refactor, debug, and learn through chat. Ask Claude to "add error handling to this function" or "explain what this regex does."

🔗 **Remote Access via Relay** — Connect to your home machine from anywhere. Your code stays on your computer, you control it from your pocket.

📦 **Git Made Simple** — "Commit these changes", "create branch feature/auth", "show me recent commits" — version control without memorizing commands.

## Quick Start

```bash
# Install
curl -fsSL https://pockode.com/install.sh | sh

# Run
pockode -relay -auth-token YOUR_PASSWORD
```

Scan the QR code on your phone. That's it.

## Roadmap

- [ ] File browser
- [ ] Manual editing
- [ ] Voice input
- [ ] Multi-model support

## Status

Under active development. Things move fast, things might break. But that's part of the fun, right?

## Feedback

Got ideas? Found a bug? [Open an issue](https://github.com/sijiaoh/pockode/issues) — we'd love to hear from you!

> Code contributions aren't accepted yet (too much refactoring happening), but your feedback shapes the product.

## License

[O'Saasy License](LICENSE.md) — Free for personal use.
