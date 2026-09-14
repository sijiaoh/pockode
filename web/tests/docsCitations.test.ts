import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoPath, walkFiles } from "./sourceScan";

// Enforces the rule in docs/code/AGENTS.md: cite a path, never a line number.
// That rule states its own evidence; what it cannot state is why it needs a
// test. A citation rots when somebody inserts a line above it, in a file they
// never opened, and nothing goes red — so the rule cannot be held by the memory
// of whoever happens to be editing.
//
// It lives in `web/tests/` because `docs/` has no test runner of its own and
// Biome does not read markdown at all (docs/testing.md). This directory already
// reads the documentation from disk for the same reason — touchTarget.test.ts
// compares the control register against docs/responsive-ui.md — and it is
// reached by `pnpm run test` in `web`, which is a command people actually run.
// In CI it is `.github/workflows/docs.yml` that runs it, because Frontend's
// paths filter does not watch `docs/` — see docs/testing.md.

/** `docs/`, relative to the project vitest runs in (`web/`). */
const DOCS = "../docs";

/**
 * A filename followed by `:` and a number — `extensions.ts:26`, and by the same
 * token the `:26-45` range, whose first number is all this has to see.
 *
 * The extension list covers the text files this repository holds, not just the
 * source languages: a rotting citation into a config or a workflow costs the
 * reader exactly as much as one into TypeScript. Requiring a known extension
 * before the colon is what keeps `localhost:5173` and the rest of the ordinary
 * colon-then-number prose out of the results — which is also why a citation
 * into an extensionless file (`Dockerfile:12`) is out of reach: matching a bare
 * word before the colon would match most of the prose in `docs/`.
 */
const LINE_CITATION =
	/[\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|go|mod|sum|css|sh|ps1|json|ya?ml|html|md|sql|toml):\d+/g;

// The message says `line 12`, not the `:12` a terminal would make clickable: a
// guard against a form has no business printing that form.
function inspect(file: string): string[] {
	const rel = repoPath(file);
	return readFileSync(file, "utf8")
		.split("\n")
		.flatMap((text, i) =>
			[...text.matchAll(LINE_CITATION)].map(
				([match]) =>
					`${rel} line ${i + 1}\n  ${match} cites a line number — cite the path, or the symbol if the path alone will not land the reader\n  ${text.trim()}`,
			),
		);
}

// Every file, not just `*.md`: a scan that covers only the extension it was
// written for goes quiet the first time somebody adds documentation in another
// one. Everything under `docs/` is text today, and a filename-colon-digits
// match out of a binary is not a failure mode worth carrying code for.
const files = walkFiles(DOCS);

describe("documentation citations", () => {
	// The assertion below is that something is *absent*, so it would pass just
	// as happily against an empty list — a moved or renamed `docs/` would leave
	// it green forever.
	it("reads the documentation", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("cites a path, never a line number", () => {
		expect(files.flatMap(inspect)).toEqual([]);
	});
});
