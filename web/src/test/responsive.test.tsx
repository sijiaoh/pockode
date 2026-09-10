import {
	BREAKPOINTS,
	hasCoarsePointer,
	MEDIA_QUERIES,
	useHasCoarsePointer,
	useHasFinePointer,
	useIsExpanded,
	useMediaQuery,
} from "@pockode/shared";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

// The responsive infrastructure lives in packages/shared, which has no test
// runner of its own; web is where it is consumed, so it is verified from here.

/**
 * A matchMedia that answers from a live set of matching queries and notifies
 * its listeners when that set changes — enough to model a window crossing a
 * breakpoint or a mouse being plugged in mid-session.
 */
function installMatchMedia(matching: string[]) {
	const listeners = new Map<string, Set<(e: MediaQueryListEvent) => void>>();
	let current = new Set(matching);

	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: (query: string) => ({
			// A getter, not a snapshot: the real `matches` is live on the
			// MediaQueryList, and code that holds on to one relies on that.
			get matches() {
				return current.has(query);
			},
			media: query,
			addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
				const set = listeners.get(query) ?? new Set();
				set.add(fn);
				listeners.set(query, set);
			},
			removeEventListener: (
				_: string,
				fn: (e: MediaQueryListEvent) => void,
			) => {
				listeners.get(query)?.delete(fn);
			},
		}),
	});

	return function setMatching(next: string[]) {
		const before = current;
		current = new Set(next);
		act(() => {
			for (const [query, fns] of listeners) {
				if (before.has(query) === current.has(query)) continue;
				for (const fn of fns) {
					fn({
						matches: current.has(query),
						media: query,
					} as MediaQueryListEvent);
				}
			}
		});
	};
}

const AT_LEAST_REGULAR = `(min-width: ${BREAKPOINTS.sm}px)`;
const AT_LEAST_EXPANDED = `(min-width: ${BREAKPOINTS.lg}px)`;
const FINE = "(hover: hover) and (pointer: fine)";
const ANY_COARSE = "(any-pointer: coarse)";
const PRIMARY_COARSE = "(pointer: coarse)";

const original = window.matchMedia;
afterEach(() => {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		configurable: true,
		value: original,
	});
});

function Probe({ read }: { read: () => string }) {
	return <output>{read()}</output>;
}

function renderProbe(read: () => string) {
	render(<Probe read={read} />);
	return () => screen.getByRole("status").textContent;
}

describe("width ladder", () => {
	it("keeps the two-column threshold at lg, not the old 768", () => {
		// The stylesheet guard only proves the CSS agrees with these constants; it
		// would happily follow them anywhere. This is what pins the ladder itself.
		expect(BREAKPOINTS.sm).toBe(640);
		expect(BREAKPOINTS.lg).toBe(1024);
	});

	it.each([
		// A mini pad clears sm but not lg, so it stays single-column.
		{ tier: "regular", matching: [AT_LEAST_REGULAR], expanded: "false" },
		{
			tier: "expanded",
			matching: [AT_LEAST_REGULAR, AT_LEAST_EXPANDED],
			expanded: "true",
		},
	])("reports expanded=$expanded at $tier width", ({ matching, expanded }) => {
		installMatchMedia(matching);

		const read = renderProbe(() => String(useIsExpanded()));

		expect(read()).toBe(expanded);
	});

	it("follows the viewport across a breakpoint instead of sampling once", () => {
		const setMatching = installMatchMedia([]);
		const read = renderProbe(() => String(useIsExpanded()));
		expect(read()).toBe("false");

		setMatching([AT_LEAST_REGULAR, AT_LEAST_EXPANDED]);

		expect(read()).toBe("true");
	});
});

describe("pointer gates", () => {
	// The hit-area gate has no named hook: every hit-area decision is made by the
	// `pointer-coarse:` CSS variant, so `MEDIA_QUERIES.anyCoarsePointer` is the
	// shared value both sides derive from — tests/responsiveTokens.test.ts pins
	// the variant to it. Reading it through `useMediaQuery` here is what a JS call
	// site would write if one ever appeared.
	//
	// All three gates are read in one probe because a touchscreen laptop is the
	// only device that answers them differently, so it is the only environment
	// where asking the wrong question shows up. The fake matchMedia keys off the
	// literals above, so a gate whose query drifts stops matching and answers
	// wrong here.
	it("do not negate each other: a touchscreen laptop answers all three apart", () => {
		installMatchMedia([FINE, ANY_COARSE]);

		const read = renderProbe(
			() =>
				`${useHasFinePointer()}/${useMediaQuery(MEDIA_QUERIES.anyCoarsePointer)}/${useHasCoarsePointer()}`,
		);

		// Trackpad earns hover reveal, touchscreen earns thumb-sized hit areas,
		// and the primary pointer stays fine, so Enter still sends.
		expect(read()).toBe("true/true/false");
		expect(hasCoarsePointer()).toBe(false);
	});

	it("read a phone's primary pointer as coarse", () => {
		installMatchMedia([PRIMARY_COARSE, ANY_COARSE]);

		const read = renderProbe(() => String(useHasCoarsePointer()));

		expect(read()).toBe("true");
		expect(hasCoarsePointer()).toBe(true);
	});

	it("notices a mouse plugged in after mount", () => {
		const setMatching = installMatchMedia([ANY_COARSE, PRIMARY_COARSE]);
		const read = renderProbe(() => String(useHasFinePointer()));
		expect(read()).toBe("false");

		setMatching([ANY_COARSE, FINE]);

		expect(read()).toBe("true");
	});
});
