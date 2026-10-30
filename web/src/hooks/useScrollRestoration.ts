import {
	createContext,
	type Ref,
	useCallback,
	useContext,
	useLayoutEffect,
	useRef,
} from "react";
import type { ScrollMemory } from "../lib/scrollMemory";

export interface ScrollRestorationScope {
	memory: ScrollMemory;
	/**
	 * The history entry the pages under the provider are rendered for; null
	 * before the first one is.
	 */
	entry: string | null;
}

/**
 * Provided once, by the app shell. A context rather than the router's hooks
 * read in each scroller, so that a page rendered without the shell — in a
 * test that mocks the router, say — is an ordinary scroller and needs nothing
 * arranged for it. For the same reason the provider's value is computed in
 * `useScrollRestorationScope.ts`, not here: this module must not import the
 * router at all, since a browser test's `vi.mock` of it is a real ES module
 * and an import of a name the mock leaves out fails the whole file at load.
 */
export const ScrollRestorationContext =
	createContext<ScrollRestorationScope | null>(null);

/**
 * How long a restore keeps trying while the page's content arrives. Long
 * enough for a read the cache does not already hold to answer on a phone;
 * after that a late jump would land on a reader who has moved on.
 */
const RESTORE_WINDOW_MS = 3000;

/** Any of these on the scroller is the reader taking over from the restore. */
const SCROLL_GESTURES = ["wheel", "touchstart"];
/**
 * And any of these anywhere: a page's controls outside its scroller move it
 * too — an archive pager, a jump to the next conflict, a settings section —
 * and a restore still waiting for content would put the scroller back over
 * that.
 */
const ACTIONS = ["pointerdown", "keydown"];

/**
 * Where a fresh visit starts instead of the top, asked for by the content of a
 * scroller rather than written by it (see `useFreshVisitLanding`).
 */
interface Landing {
	/** The entry the content was rendered for. */
	entry: string | null;
	/** The `scrollTop` to start at, computed against the scroller. */
	target: (scroller: HTMLElement) => number;
	/** Called once the landing has been written; never for a return. */
	onLanded: () => void;
}

/** Asks for a landing; returns what withdraws it, should it still be waiting. */
export type Land = (
	target: Landing["target"],
	onLanded: Landing["onLanded"],
) => () => void;

/** Provided by `PageBody` around its content. */
export const LandingContext = createContext<Land | null>(null);

/**
 * The scroller around a page's content, for content that knows where a fresh
 * visit to it should start — a file opened at a line. Null outside a
 * `PageBody`. Only a fresh visit lands, and once per entry; a return keeps
 * what it saved.
 *
 * A request rather than a write of `scrollTop`, because the content cannot
 * write it itself: the scroller answers an entry change in its own layout
 * effect, which as an ancestor's runs after the content's and would put the
 * fresh entry back at the top over the landing.
 */
export function useFreshVisitLanding(): Land | null {
	return useContext(LandingContext);
}

/**
 * A ref for a page's scroll container that puts it back where the reader left
 * it when they come back to the page (see `lib/scrollMemory.ts` for what
 * counts as coming back). A fresh visit starts at the top. Pages get it from
 * `PageBody`; use this directly only for a scroller that cannot be one.
 *
 * Content that is still loading has no height to scroll into, so the restore
 * keeps writing the position frame by frame until the page is tall enough,
 * the reader scrolls or presses anything, or `RESTORE_WINDOW_MS` passes.
 *
 * `own` is a ref the page keeps to the scroller for its own use; the returned
 * ref fills it too, since an element takes only one.
 *
 * `id` tells apart two scrollers of one page that both remember.
 */
export function useScrollRestoration<T extends HTMLElement>(
	own?: Ref<T>,
	id = "page",
) {
	return useRestoredScroller(own, id).ref;
}

/**
 * `useScrollRestoration`, plus the `Land` its content asks a fresh visit's
 * start of through `LandingContext`.
 */
export function useRestoredScroller<T extends HTMLElement>(
	own?: Ref<T>,
	id = "page",
): { ref: (scroller: T | null) => (() => void) | undefined; land: Land } {
	const scope = useContext(ScrollRestorationContext);
	const memory = scope?.memory;
	const entry = scope?.entry ?? null;
	// Read at each scroll rather than captured once, so that a page staying
	// mounted across a replace keeps saving under the entry it is now on.
	const entryRef = useRef(entry);
	entryRef.current = entry;
	// The mounted scroller's answer to the entry changing under it.
	const showRef = useRef<((entry: string) => void) | null>(null);
	// A landing not yet taken: asked for in the content's layout effect, which
	// runs before the scroller is attached or has shown the entry asked for.
	const landingRef = useRef<Landing | null>(null);
	// The mounted scroller's answer to a landing asked for.
	const takeRef = useRef<((landing: Landing) => void) | null>(null);

	// A page can stay mounted from one entry to the next — a document and the
	// one it links to are the same view — and then coming back to the first is
	// no mount. Layout, so it lands before the browser paints the other page's
	// position or reports a scroll of it.
	useLayoutEffect(() => {
		if (entry !== null) showRef.current?.(entry);
	}, [entry]);

	const land = useCallback<Land>((target, onLanded) => {
		const landing = { entry: entryRef.current, target, onLanded };
		landingRef.current = landing;
		takeRef.current?.(landing);
		return () => {
			if (landingRef.current === landing) landingRef.current = null;
		};
	}, []);

	const ref = useCallback(
		(scroller: T | null) => {
			if (!scroller) return;
			const release = attach(own, scroller);
			let restoring = false;
			let frame = 0;

			const stop = () => {
				restoring = false;
				cancelAnimationFrame(frame);
				for (const type of SCROLL_GESTURES) {
					scroller.removeEventListener(type, stop);
				}
				for (const type of ACTIONS) {
					scroller.ownerDocument.removeEventListener(type, stop, true);
				}
			};

			const restore = (target: number) => {
				restoring = true;
				const deadline = performance.now() + RESTORE_WINDOW_MS;
				const attempt = () => {
					scroller.scrollTop = target;
					if (
						Math.abs(scroller.scrollTop - target) < 1 ||
						performance.now() > deadline
					) {
						stop();
						return;
					}
					frame = requestAnimationFrame(attempt);
				};
				for (const type of SCROLL_GESTURES) {
					scroller.addEventListener(type, stop, { passive: true });
				}
				// Capturing, so a control that stops the event's propagation
				// still counts.
				for (const type of ACTIONS) {
					scroller.ownerDocument.addEventListener(type, stop, {
						capture: true,
						passive: true,
					});
				}
				attempt();
			};

			let shown = entryRef.current;
			// Judged when the entry is shown, not when the landing is asked for:
			// by then the reset to the top has been saved as the entry's offset.
			// With no memory nothing is ever returned to.
			let fresh = true;

			const takeLanding = (landing: Landing) => {
				landingRef.current = null;
				if (memory && !fresh) return;
				fresh = false;
				stop();
				scroller.scrollTop = landing.target(scroller);
				scroller.scrollLeft = 0;
				// Saved at once rather than by the scroll event, so the entry's
				// own show in this commit finds it there and leaves it.
				if (memory && shown !== null) {
					memory.set(shown, id, scroller.scrollTop);
				}
				landing.onLanded();
			};
			const landingFor = (entry: string | null) =>
				landingRef.current?.entry === entry ? landingRef.current : null;

			const take = (landing: Landing) => {
				if (landing.entry === shown) takeLanding(landing);
			};
			takeRef.current = take;
			const releaseTake = () => {
				if (takeRef.current === take) takeRef.current = null;
			};

			if (!memory) {
				const landing = landingFor(shown);
				if (landing) takeLanding(landing);
				return () => {
					release();
					releaseTake();
				};
			}

			const saved = shown === null ? undefined : memory.get(shown, id);
			fresh = saved === undefined;
			const landing = landingFor(shown);
			if (fresh && landing) takeLanding(landing);
			else if (saved !== undefined && saved > 0) restore(saved);

			// A replace hands its offsets on (see `lib/scrollMemory.ts`), so an
			// entry that remembers none is a fresh visit, and starts at the top —
			// or where its content asked to land — rather than at the offset of
			// the page it replaced.
			const show = (entry: string) => {
				if (entry === shown) return;
				shown = entry;
				stop();
				const saved = memory.get(entry, id);
				fresh = saved === undefined;
				const landing = landingFor(entry);
				if (fresh && landing) {
					takeLanding(landing);
					return;
				}
				const target = saved ?? 0;
				if (scroller.scrollTop !== target) restore(target);
			};
			showRef.current = show;

			// The restore's own writes are not the reader's position: while the
			// content is short they are clamped, and saving that would lose the
			// target for the next visit.
			const save = () => {
				const entry = entryRef.current;
				if (!restoring && entry !== null) {
					memory.set(entry, id, scroller.scrollTop);
				}
			};
			scroller.addEventListener("scroll", save, { passive: true });

			return () => {
				release();
				stop();
				if (showRef.current === show) showRef.current = null;
				releaseTake();
				scroller.removeEventListener("scroll", save);
			};
		},
		[own, memory, id],
	);

	return { ref, land };
}

/**
 * Points `ref` at `element` and returns what undoes that: a ref callback that
 * returns a cleanup is not called again with null, so neither is `ref`.
 */
function attach<T>(ref: Ref<T> | undefined, element: T): () => void {
	if (typeof ref === "function") {
		const cleanup = ref(element);
		return typeof cleanup === "function" ? cleanup : () => ref(null);
	}
	if (ref) ref.current = element;
	return () => {
		if (ref) ref.current = null;
	};
}
