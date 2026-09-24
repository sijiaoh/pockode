import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOTS, repoPath, sourceFiles } from "./sourceScan";

// Height is not a third axis (docs/responsive-ui.md, "The two axes"). There is
// one exception in the whole app — the answer panel folding chrome away under a
// soft keyboard (docs/answering-ui.md §3) — and both documents say in words
// that nothing else may read it.
//
// A rule that only exists in prose is held by whoever happens to remember it.
// The second caller is what turns the exception into an axis, and it would
// arrive in a file nobody reviewing this rule has open, so it is checked here
// instead — the same argument docsCitations.test.ts makes for itself.
//
// Outside `src` because reading the tree as files needs Node types, which the
// app project deliberately does not have.

/** The hook, and the one surface the exception was granted to. */
const OWNER = "web/src/hooks/useShortViewport.ts";
const ALLOWED = new Set([OWNER, "web/src/components/Chat/ChatPanel.tsx"]);

const readers = ROOTS.flatMap(sourceFiles)
	.filter((file) => /useShortViewport/.test(readFileSync(file, "utf8")))
	.map(repoPath)
	.sort();

describe("the height gate", () => {
	// Against a scan that has quietly stopped finding anything: an assertion
	// that a list holds nothing unexpected passes just as happily on an empty
	// one, and a moved hook would leave this green forever.
	it("is found where it lives", () => {
		expect(readers).toContain(OWNER);
	});

	it("is read by nothing but the answer panel's host", () => {
		expect(readers.filter((f) => !ALLOWED.has(f))).toEqual([]);
	});

	// The gate is a `max-height` media query, so it only moves when the *layout*
	// viewport does — and a soft keyboard, by default, shrinks the visual
	// viewport and leaves the layout viewport where it was.
	// `interactive-widget=resizes-content` is what asks the browser to shrink
	// the layout viewport instead, and it is the whole reason a media query is
	// enough here rather than a `visualViewport` pipeline. Take it out of the
	// meta tag and the gate quietly stops firing on the one device it exists
	// for, with every test still green.
	it("is kept live by the viewport meta tag it depends on", () => {
		const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
		expect(html).toMatch(
			/name="viewport"[^>]*interactive-widget=resizes-content/,
		);
	});
});
