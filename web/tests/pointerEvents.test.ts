import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOTS, repoPath, sourceFiles } from "./sourceScan";

// Mouse events on a touch screen are compatibility emulation: the browser
// withholds them while a gesture might turn into a scroll, and never sends them
// for a stylus at all. Anything that tracks a pointer through a gesture — a
// drag, or "did that land outside me?" — has to listen for pointer events, or
// it works for a mouse and silently does nothing for a finger. That is how the
// sidebar's resize handle came to be undraggable on a tablet.
//
// See docs/responsive-ui.md.
//
// `mousedown` alone is not flagged: `onMouseDown={e => e.preventDefault()}` is
// the standard way to keep focus where it is when a control is pressed, and it
// has no pointer-event equivalent (preventing `pointerdown` does not stop the
// focus change). A drag started that way is still caught, because it cannot be
// followed without the move and release below.
// The listener names are matched quoted, so the word `mousedown` in prose does
// not trip the scan — either quote style, since a file that slipped past the
// formatter must not slip past this too. Handler props are matched
// case-insensitively to cover the DOM spelling (`el.onmouseup = ...`) as well
// as React's.
const TRACKING: [label: string, pattern: RegExp][] = [
	["a mouse handler prop", /\bonmouse(move|up|enter|leave)\b/i],
	["an addEventListener name", /["'](mousemove|mouseup|mousedown)["']/],
];

function inspect(file: string): string[] {
	const source = readFileSync(file, "utf8");
	return TRACKING.filter(([, pattern]) => pattern.test(source)).map(
		([label]) =>
			`${repoPath(file)}\n  ${label} tracks a pointer with mouse events; a finger or a stylus never sends them — use the pointer-event equivalent`,
	);
}

describe("pointer events", () => {
	it("never tracks a gesture with mouse events", () => {
		expect(ROOTS.flatMap(sourceFiles).flatMap(inspect)).toEqual([]);
	});
});
