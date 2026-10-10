<div align="center">

<!-- messaging:logo -->
<img src="site/static/images/logo.svg" alt="Pockode" width="96">
<!-- /messaging:logo -->

# Pockode

<!-- messaging:tagline -->
**Your coding agents keep working. Steer them from your phone.**

Hand stories to a team of Claude Code and Codex agents on your own machine, answer their questions and ship the result from any browser.
<!-- /messaging:tagline -->

[![Server](https://github.com/sijiaoh/pockode/actions/workflows/server.yml/badge.svg)](https://github.com/sijiaoh/pockode/actions/workflows/server.yml)
[![Frontend](https://github.com/sijiaoh/pockode/actions/workflows/frontend.yml/badge.svg)](https://github.com/sijiaoh/pockode/actions/workflows/frontend.yml)
[![Release](https://img.shields.io/github/v/release/sijiaoh/pockode)](https://github.com/sijiaoh/pockode/releases)

[Website](https://pockode.com) · [Docs](https://pockode.com/docs/) · [Changelog](https://pockode.com/changelog/)

<!-- messaging:demo -->
<img src="site/static/marketing/video/demo.gif" alt="A 30-second demo of Pockode: a story split into tasks that agents work on in parallel, an agent's question answered from a phone, the diff, Port Preview and a commit" width="800">
<!-- /messaging:demo -->

</div>

## Quick Start

<!-- messaging:quickstart -->
Pockode drives the `claude` or `codex` CLI, so install one of them on the same machine first.

**macOS / Linux**

```sh
# Install
curl -fsSL https://pockode.com/install.sh | sh

# Run (on your dev machine, in your project directory)
pockode -password YOUR_PASSWORD
```

**Windows**

```powershell
# Install
irm https://pockode.com/install.ps1 | iex

# Run (on your dev machine, in your project directory)
pockode -password YOUR_PASSWORD
```

Scan the QR code with your phone.
<!-- /messaging:quickstart -->

<!-- messaging:platforms -->
Runs on macOS (Intel and Apple silicon), Linux (amd64 and arm64) and Windows (x64, also on Windows 11 on Arm).
<!-- /messaging:platforms -->
Install options, verifying the download and upgrading: [platform support](docs/platforms.md). Several projects on one machine: [cluster mode](docs/cluster.md). Pre-1.0 and released often: read the [release notes](https://github.com/sijiaoh/pockode/releases) before upgrading.

## Features

<!-- messaging:pillars -->
- **Delegate** — Split a story into tasks, each run by a Claude Code or Codex agent in its own role.
- **Stay in the loop** — When an agent needs a decision, it stops and asks; you answer from anywhere.
- **Review & ship** — Read the diff, commit, and open your dev server on your phone with Port Preview.
- **Your machine** — Pockode dials out from beside your project, so there is no port to forward.
<!-- /messaging:pillars -->

<!-- messaging:screenshots -->
<table>
  <tr>
    <td><img src="site/static/marketing/screenshots/phone-story.png" alt="A story, Add due dates to todos, with three tasks assigned to Engineer agents and one question waiting for your answer" width="240"></td>
    <td><img src="site/static/marketing/screenshots/phone-question.png" alt="An agent's question on a phone: where should todos without a due date go? The recommended answer is to put them after dated todos." width="240"></td>
  </tr>
  <tr>
    <td><img src="site/static/marketing/screenshots/phone-diff.png" alt="The diff of TodoItem.tsx on a phone" width="240"></td>
    <td><img src="site/static/marketing/screenshots/phone-preview.png" alt="The todo app's dev server, opened on the phone with Port Preview" width="240"></td>
  </tr>
</table>
<!-- /messaging:screenshots -->

## How it works

```mermaid
flowchart LR
    subgraph machine["Your machine"]
        pockode["pockode"] -- spawns --> cli["claude / codex"]
    end
    phone["Your phone<br/>(any browser)"] -- HTTPS / WSS --> relay["Relay<br/>(cloud)"]
    pockode -- outbound tunnel --> relay
```

Pockode runs beside your project and drives the AI CLI there. [How it is secured](https://pockode.com/security/).

## Contributing · Security · License

- **Contributing** — Issues, [discussions](https://github.com/sijiaoh/pockode/discussions) and documentation PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security** — Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
  <!-- messaging:license -->
- **License** — Source available under the [O'Saasy License](LICENSE.md). You may use, modify and redistribute it, but not offer it to others as a competing hosted service.
  <!-- /messaging:license -->
