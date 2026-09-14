# Code Explanation Documentation

Explain **why** the code is designed this way, not **what** the code does.

## Core Principles

- Focus on design decisions and trade-offs
- Avoid redundancy with code comments (DRY)
- Use English
- Each document should be independently readable
- **Cite a path, never a line number** — `// web/src/lib/extensions.ts`, not
  `extensions.ts:26-45`. Line numbers rot silently: one refactor broke 6 of the
  12 this repository used to carry, while the path-only citations never broke.
  When a snippet starts mid-body and the path alone will not land the reader,
  name the symbol instead — `// server/watch/fs.go — Subscribe`. A symbol
  survives an inserted line; a number does not.
