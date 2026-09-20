import { describe, expect, it } from "vitest";
import { classHelpers, classSites } from "./classScan";
import { ROOTS, sourceFiles } from "./sourceScan";

// A box pinned to the viewport's height (`h-dvh` and its family) is a claim
// that it *is* the window. Unclipped, it is also a promise the layout cannot
// keep: anything inside that ends up taller pushes past the bottom and makes
// the document a scroll container — invisibly, until a reader reaches the end
// of one of the panels that scroll themselves and the wheel chains out into the
// page. Pin the height and keep the overflow to yourself, or say `min-h-dvh`
// and mean it; what must not exist is the third thing, a viewport-tall box that
// neither contains its overflow nor admits it scrolls. Who owns the boundary,
// and why `overscroll-behavior` is not the answer, is
// docs/responsive-ui.md § Who owns the scroll boundary.

/**
 * One class with its variant prefixes stripped: `has-[:focus-visible]:lg:h-dvh`
 * is still a box pinned to the viewport, at that width and in that state.
 *
 * Prefixes are peeled rather than split on `:`, because a prefix may carry a
 * colon of its own inside brackets — `supports-[display:grid]:` — and because
 * the alternative, a `[\w-]+:` prefix pattern, silently misses every variant
 * Tailwind spells with a bracket or a slash. `has-[…]:` is already in use here,
 * and this scan has to hold for components nobody has written yet.
 */
function utility(token: string): string {
	const prefix = /^(?:\[[^\]]*\]|[^\s:[])+:/;
	let rest = token;
	while (prefix.test(rest)) rest = rest.replace(prefix, "");
	return rest;
}

// `min-h-` and `max-h-` are deliberately absent, and for different reasons. A
// minimum is the other half of this rule — the spelling that admits the page
// scrolls. A maximum cannot make the box any taller than the viewport, so it
// cannot grow the document either.
const PINS = [
	/^h-(?:dvh|svh|lvh|screen)$/,
	// The arbitrary spelling of the same thing: `h-[100dvh]`, `h-[50vh]`, and
	// `h-[calc(100vh-3rem)]` — hence the tail, which an earlier cut requiring the
	// unit to end the bracket missed.
	/^h-\[[^\]]*v(?:h|min|max)[^\]]*\]$/,
];

// Any overflow value but `visible` keeps the box's own overflow to itself, so
// `overflow-y-auto` satisfies this rule as squarely as `overflow-hidden` does —
// a viewport-tall box that scrolls internally never reaches the document. Only
// clipping is *suggested* in the failure message, because it is the answer for
// a shell; a scroller knows it is one.
const CONTAINS = /^overflow(?:-y)?-(?:hidden|clip|auto|scroll)$/;

const pins = (classes: string) =>
	classes.split(" ").some((t) => PINS.some((p) => p.test(utility(t))));

const contains = (classes: string) =>
	classes.split(" ").some((t) => CONTAINS.test(utility(t)));

const files = ROOTS.flatMap(sourceFiles);
const helpers = classHelpers(files);

/**
 * Every class list in the front end that pins its box to the viewport height
 * and lets its overflow out.
 *
 * Per branch, not per element: a `className` that only pins in one arm of a
 * ternary has to contain its overflow in that arm, and merging the arms would
 * let the other one's `overflow-hidden` answer for it.
 */
function unconstrainedPins(file: string): string[] {
	return classSites(file, helpers).flatMap((site) =>
		site.classes
			.filter((classes) => pins(classes) && !contains(classes))
			.map(
				(classes) =>
					`${site.file}:${site.line}\n  pins its height to the viewport and lets its overflow out, so anything taller inside it scrolls the whole page: ${classes}\n  either add overflow-hidden, or say min-h-* if this screen is the page and means to scroll`,
			),
	);
}

describe("viewport-height boxes", () => {
	it("either contain their overflow or say min-h-*", () => {
		expect(files.flatMap(unconstrainedPins)).toEqual([]);
	});
});

// Two blind spots, recorded as they are rather than as they should be:
//
// 1. A viewport height written in an inline `style` is invisible here. The
//    scan reads class lists, so `style={{ height: "100dvh" }}` is not matched
//    and neither is the `overflow` that would answer for it. Nothing writes a
//    height that way today — heights are classes throughout both front ends —
//    and half-matching it would report the height while missing the clip.
// 2. `min-h-*` is accepted wherever it appears, including inside a shell that
//    clips. There it is not a page that scrolls, it is content quietly cut off
//    at the fold. Telling the two apart means knowing what encloses the box,
//    which a text scan does not; the rule is phrased around the one thing it
//    can see. A reviewer catches that one.
