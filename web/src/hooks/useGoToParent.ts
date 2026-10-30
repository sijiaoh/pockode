import { type AnyRouter, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { entryKeyOf, historyTrailFor } from "../lib/historyTrail";
import { buildNavigation, overlayToNavigation } from "../lib/navigation";
import { routeKeyOf } from "../lib/routes";
import { FRESH_VISIT_STATE } from "../lib/scrollMemory";
import { isUnder, type Page, parentOf, samePage } from "../types/overlay";
import { routeInfoOf } from "./useRouteState";

/** The entry a `go()` has been issued from and has not left yet. */
let goingFrom: string | undefined;

/**
 * How far back a walk goes. Chrome and Firefox keep 50 entries a tab and drop
 * the oldest while `__TSR_index` goes on counting, so an entry further back
 * may be one the browser no longer has — and a `go()` to it does nothing at
 * all. Past this the walk stops, as at the start of what is known.
 */
const MAX_STEPS_BACK = 40;

/**
 * How long a `go()` is waited for. One that never lands — the browser has
 * dropped the entry after all — would otherwise leave ← dead on the page.
 * A `go()` to another document's entry may only be slow to begin unloading
 * this one, so its rewrite is kept for the next document past this: an entry
 * the browser has dropped can never be arrived at.
 */
const GO_TIMEOUT_MS = 1000;

interface PageAt extends Page {
	sessionId: string | null;
}

/** What page an entry of the trail is, read as the route on screen is read. */
function pageAt(router: AnyRouter, href: string): PageAt | undefined {
	try {
		const [beforeHash] = href.split("#");
		const queryAt = beforeHash.indexOf("?");
		const pathname = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
		const search = router.options.parseSearch(
			queryAt < 0 ? "" : beforeHash.slice(queryAt),
		);
		const leaf = router.matchRoutes(pathname, search).at(-1);
		const route = leaf && routeKeyOf(leaf.routeId);
		// A search the route's schema rejects is no page this app shows.
		if (!leaf || !route || leaf.searchError) return undefined;
		const params = leaf.params as { worktree?: string };
		const { overlay, sessionId } = routeInfoOf(
			route,
			leaf.params,
			leaf.search ?? {},
			params.worktree ?? "",
		);
		return { worktree: params.worktree ?? "", overlay, sessionId };
	} catch {
		// A URL the routes refuse is no page this app knows either, and the
		// walk stops there as at the trail's start.
		return undefined;
	}
}

/**
 * The in-app ← of a page: up to its parent (`parentOf`), never back along
 * whatever the reader did (docs/project-ui.md). The browser's Back retraces;
 * this goes up — so after it, Back never lands on the page just left.
 *
 * Walks the trail (lib/historyTrail.ts) back from the page, past every entry
 * opened under the parent — its other children, theirs, the parent's own
 * siblings paged through. Reaching the parent's own entry, it goes back to it
 * (and writes the parent's exact URL over it if the parent has changed since,
 * a History query edited meanwhile); reaching anything else, or the start of
 * what is known — a link, a reload of an unknown trail, a typed URL, or
 * further back than the browser may still keep — it goes back to the oldest
 * page it skipped and puts the parent in its place. Either way every page
 * opened under the parent leaves the way back.
 *
 * `from` is the page asking. A press is always on it; an answer that arrives
 * later — a commit made from the review, a discard, a delete — may find the
 * reader has moved on, and moves nobody then.
 *
 * A second ← before the first `go()` has landed — a double tap, a commit
 * answering while a discard does — is dropped while the window is still on
 * the entry left: it would go up from where the first one is already going.
 */
export function useGoToParent(): (from: Page) => void {
	const router = useRouter();
	const navigate = useNavigate();
	// From the first render on: a trail first asked for at the press would
	// know nothing behind it. The app's router has made it already.
	historyTrailFor(router.history);
	return useCallback(
		(from) => {
			const { history } = router;
			const left = entryKeyOf(history.location);
			if (left === goingFrom) return;
			const here = pageAt(router, history.location.href);
			if (!here || !samePage(here, from)) return;
			const up = parentOf(here.overlay);
			if (up === undefined) return;
			const parent: Page = { worktree: here.worktree, overlay: up };
			const target = up
				? overlayToNavigation(up, here.worktree, here.sessionId)
				: buildNavigation(
						here.sessionId
							? {
									type: "session",
									worktree: here.worktree,
									sessionId: here.sessionId,
								}
							: { type: "home", worktree: here.worktree },
					);
			// Fresh unless it is the parent's own entry being brought up to date:
			// what the page it stands in for was scrolled to is not the parent's.
			const replaceWithParent = (fresh = true) =>
				navigate({
					...target,
					replace: true,
					...(fresh ? { state: FRESH_VISIT_STATE } : {}),
				});
			const targetHref = router.buildLocation(target).href;

			const trail = historyTrailFor(history);
			const index = trail.index;
			if (index === undefined) {
				replaceWithParent();
				return;
			}
			let landing = index;
			let isParent = false;
			for (let i = index - 1; i >= Math.max(0, index - MAX_STEPS_BACK); i--) {
				const entry = trail.at(i);
				const page = entry && pageAt(router, entry.href);
				if (!page) break;
				if (samePage(page, parent)) {
					landing = i;
					isParent = true;
					break;
				}
				if (!isUnder(page, parent)) break;
				landing = i;
			}
			if (landing === index) {
				replaceWithParent();
				return;
			}
			const landed = trail.at(landing);
			if (!landed) return;
			const rewrite = !isParent || landed.href !== targetHref;
			// An entry from before a reload belongs to a document that is gone:
			// going to it loads the app afresh, and only the trail, reading
			// storage as it starts, can still put the parent there.
			if (rewrite) trail.rewriteOnArrival(landed.key, targetHref);
			const crossDocument = landed.doc !== trail.document;

			goingFrom = left;
			const settle = () => {
				goingFrom = undefined;
				clearTimeout(fallback);
				stop();
			};
			const fallback = setTimeout(() => {
				settle();
				if (!crossDocument) trail.cancelRewrite();
				if (entryKeyOf(history.location) === left) replaceWithParent();
			}, GO_TIMEOUT_MS);
			const stop = history.subscribe(({ location, action }) => {
				// The entry left, corrected while the move is under way.
				if (action.type === "REPLACE") return;
				settle();
				trail.cancelRewrite();
				// A push is somewhere else the reader went: the move is theirs.
				if (action.type === "PUSH") return;
				if (!rewrite || entryKeyOf(location) !== landed.key) return;
				// After the router has had the move: a navigation from inside
				// the history's own notification would race the one it starts.
				queueMicrotask(() => {
					if (entryKeyOf(history.location) === landed.key) {
						replaceWithParent(!isParent);
					}
				});
			});
			history.go(landing - index);
		},
		[router, navigate],
	);
}
