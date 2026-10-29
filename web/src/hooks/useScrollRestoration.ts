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
	const scope = useContext(ScrollRestorationContext);
	const memory = scope?.memory;
	const entry = scope?.entry ?? null;
	// Read at each scroll rather than captured once, so that a page staying
	// mounted across a replace keeps saving under the entry it is now on.
	const entryRef = useRef(entry);
	entryRef.current = entry;
	// The mounted scroller's answer to the entry changing under it.
	const showRef = useRef<((entry: string) => void) | null>(null);

	// A page can stay mounted from one entry to the next — a document and the
	// one it links to are the same view — and then coming back to the first is
	// no mount. Layout, so it lands before the browser paints the other page's
	// position or reports a scroll of it.
	useLayoutEffect(() => {
		if (entry !== null) showRef.current?.(entry);
	}, [entry]);

	return useCallback(
		(scroller: T | null) => {
			if (!scroller) return;
			const release = attach(own, scroller);
			if (!memory) return release;
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
			const target = shown === null ? undefined : memory.get(shown, id);
			if (target !== undefined && target > 0) restore(target);

			// A replace hands its offsets on (see `lib/scrollMemory.ts`), so an
			// entry that remembers none is a fresh visit, and starts at the top
			// rather than at the offset of the page it replaced.
			const show = (entry: string) => {
				if (entry === shown) return;
				shown = entry;
				stop();
				const target = memory.get(entry, id) ?? 0;
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
				scroller.removeEventListener("scroll", save);
			};
		},
		[own, memory, id],
	);
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
