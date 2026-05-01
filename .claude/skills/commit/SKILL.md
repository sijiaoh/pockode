---
name: commit
description: Review all changes and create a commit. Use "/commit [pattern]" to filter changes by pattern.
---

# Commit

Review current changes and create a commit.

**MUST check actual changes first** — run `git status` and `git diff`. Never rely on memory; files may have been modified externally.

If `$ARGUMENTS` is provided, only commit changes matching the pattern (by path or content). Otherwise, commit all changes.

Commit message best practices:
- Imperative mood ("Add X" not "Added X")
- Under 50 characters
- Focus on what and why, not how
