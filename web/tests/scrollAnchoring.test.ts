import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOTS, repoPath, sourceFiles } from "./sourceScan";

// `overflow-anchor: none` switches off the browser's own scroll anchoring —
// the thing that keeps a reader's place when content is inserted above them.
//
// One list in the app is entitled to that: the transcript pins its own anchor
// by hand around every history page it prepends, and the browser's would fight
// it. Every other list does no measuring of its own, so switching it off is
// switching off the only thing measuring for them. The session sidebar is the
// case this scan was written for: a session created while the reader is far
// down the list is the one event that moves everything below it, and scroll
// anchoring is the whole of the answer (docs/list-paging-ui.md §3.2, check 10).
//
// Both spellings that reach the browser from a .tsx file: Tailwind's arbitrary
// property, and the inline-style key. Prose is deliberately not matched — the
// two files that explain why this is left on say the property's name to do it.
const DISABLES = [/\[overflow-anchor:/i, /overflowAnchor\s*:/];

const ENTITLED = ["web/src/components/Chat/MessageList.tsx"];

function inspect(file: string): string[] {
	const source = readFileSync(file, "utf8");
	if (!DISABLES.some((pattern) => pattern.test(source))) return [];
	const path = repoPath(file);
	if (ENTITLED.includes(path)) return [];
	return [
		`${path}\n  turns off scroll anchoring; a list that does no scroll measuring of its own must not disable the thing that measures for it (docs/list-paging-ui.md §3.2)`,
	];
}

describe("scroll anchoring", () => {
	it("is left on everywhere but the transcript", () => {
		expect(ROOTS.flatMap(sourceFiles).flatMap(inspect)).toEqual([]);
	});

	// The exception has to keep being an exception: if the transcript stops
	// disabling anchoring, this entry is dead weight pre-approving the next one.
	it.each(ENTITLED)("%s still needs its exception", (path) => {
		const source = readFileSync(`../${path}`, "utf8");
		expect(DISABLES.some((pattern) => pattern.test(source))).toBe(true);
	});
});
