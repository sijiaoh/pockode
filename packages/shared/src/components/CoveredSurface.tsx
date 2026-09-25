import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useRef,
} from "react";

/**
 * Whether the surface this subtree belongs to has been covered. `false`
 * everywhere else, so a surface that can never be covered says nothing and
 * pays nothing.
 */
const CoveredContext = createContext(false);

export interface CoveredSurfaceProps {
	/**
	 * True while something the user went to is drawn over this subtree and the
	 * subtree is off the screen — kept mounted only so they get it back on the
	 * way out. Not "dimmed": see the note on the component.
	 */
	covered: boolean;
	children: ReactNode;
}

/**
 * Marks a subtree as coverable, so that what it portals out is covered with it.
 *
 * A covered surface takes itself off the screen and out of reach with
 * `visibility: hidden` and `inert`, and both of those travel down the DOM —
 * which is the one thing an overlay portalled to `document.body` has left
 * behind. A `Sheet` raised from this subtree is a React child of it and a DOM
 * sibling of the whole app, so without this it goes on floating over the thing
 * that covered its opener: lit, clickable, and describing a surface that is no
 * longer on screen. This carries the same fact down the tree the portal did
 * *not* leave, and every overlay this package portals out closes on it.
 *
 * **Covered is not dimmed.** A layer that belongs to the surface itself — an
 * answer panel over a transcript — leaves it on screen, in place, and one
 * dismissal away; the user has gone nowhere, and a sheet they raised from a
 * row is still theirs to finish. Pass only the fact that takes the subtree off
 * the screen. A surface that dims itself and also wants its sheets gone is
 * asking for two different rules, and this is the one about being covered.
 */
export function CoveredSurface({ covered, children }: CoveredSurfaceProps) {
	return (
		<CoveredContext.Provider value={covered}>
			{children}
		</CoveredContext.Provider>
	);
}

/**
 * Closes a portalled overlay when the surface it was raised from is covered.
 *
 * Called by everything in this package that portals to `document.body`: the
 * portal is what puts a component out of `inert`'s reach, so the portal is what
 * makes this the component's own job rather than its host's. A host only has to
 * say where its coverable surface is (`CoveredSurface`); nothing has to be
 * registered per sheet, and a sheet added later is covered by having been
 * written as a sheet.
 *
 * It closes rather than hides. Coming back has to hand the user the surface
 * they left, not a sheet they had open on it before going somewhere else — and
 * the open flag is the host's, so nothing but closing can put it down.
 *
 * `dismissible` gets no say here, and that is not an oversight: that flag
 * refuses an *accidental* dismissal while an operation is in flight, so the
 * user is never left wondering whether they cancelled it. Being covered is not
 * a stray tap on a backdrop, and honouring the flag would leave a sheet
 * floating over the overlay with its backdrop, its Escape and its close button
 * all turned off — the bug, with no way out of it.
 */
export function useCloseWhenCovered(onClose: () => void): void {
	const covered = useContext(CoveredContext);
	// Read through a ref so the close is driven by the cover alone. Callers pass
	// an inline arrow, so depending on `onClose` would re-run this on every
	// render of the host and close the sheet again on each one. Written in a
	// layout effect of its own, declared first so it has run by the time the one
	// below reads it — effects of a component run in the order they are written.
	const onCloseRef = useRef(onClose);
	useLayoutEffect(() => {
		onCloseRef.current = onClose;
	});

	// Layout, not passive: the commit that covers the surface is the one that
	// draws whatever covers it, and a passive effect runs after that has been
	// painted — one frame of the sheet sitting on top of the new screen, which
	// is the whole of what this rule is here to prevent.
	useLayoutEffect(() => {
		if (covered) onCloseRef.current();
	}, [covered]);
}
