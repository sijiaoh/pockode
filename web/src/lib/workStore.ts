import { create } from "zustand";
import type { WorkListItem } from "../types/work";
import { normalizeActivity } from "./activity";
import { isInvalidParamsRejection, wsActions } from "./wsStore";

/**
 * How many rows each capped group of `Current` is short, keyed by the group the
 * server caps rather than by the heading that shows it: `open` is the whole of
 * *Not running* now that *Stopped* has its own group, and naming it after the
 * status keeps this the same word the wire uses.
 */
export interface WorkListHidden {
	stopped: number;
	open: number;
}

/** Frozen, because it is handed out as the default on every reset. */
const NOTHING_HIDDEN: WorkListHidden = Object.freeze({ stopped: 0, open: 0 });

interface WorkState {
	/**
	 * The `Current` segment, whole: every row it draws plus everything those
	 * rows make claims about. Never a page — its group counts and the Project
	 * tab's attention dot are read off it, and an "is there any" asked of a page
	 * answers no for a list nobody has read that far
	 * (docs/list-paging-ui.md §2.1, §4.1).
	 *
	 * The one thing it can be short of is the least recently updated of
	 * *Stopped* and of *Not running*; see `hidden`.
	 */
	works: WorkListItem[];
	/**
	 * How many rows the server held back, per capped group. That group's heading
	 * adds its own number to the rows it has, so the count it shows is the whole
	 * group's; zero means nothing is missing and no control is offered.
	 *
	 * One number per group rather than one total: each is a heading on screen,
	 * and a single number spanning two of them would make at least one wrong.
	 *
	 * An approximation by one row in one case: a hidden work that changes is
	 * pushed to the client and added to `works` — which is right, since dropping
	 * an update is how a work that starts needing a person would go unnoticed —
	 * while this count still counts it. The next snapshot or sync corrects it.
	 */
	hidden: WorkListHidden;
	isLoading: boolean;
	error: string | null;
	/**
	 * The archive page on screen, and the tasks its rows speak for. Separate
	 * from `works` rather than mixed into it: the archive is a *page*, and the
	 * two lists answer to opposite rules — `works` is pushed to, this is fetched
	 * and nothing lands in it unasked (docs/list-paging-ui.md §4.3).
	 */
	archive: WorkListItem[];
	/**
	 * The cursor for each page the user has walked, oldest request first:
	 * `[""]` is page 1. Walking back is handing back a cursor already used,
	 * which is what lets the server stay one-directional and the pager say
	 * `Page 2` rather than `Page 2 of 7` (docs/list-paging-ui.md §4.2).
	 */
	archiveCursors: string[];
	/** Which entry of `archiveCursors` is on screen. */
	archivePage: number;
	/** The cursor for the page after the one on screen, null at the end. */
	archiveNextCursor: string | null;
	/** Whether a page has ever landed; until then the segment shows a spinner. */
	archiveLoaded: boolean;
	isArchiveLoading: boolean;
	/**
	 * The page last asked for, which is not always the one on screen: after a
	 * failed "Older" the rows are still the page before it, and Retry has to ask
	 * for the one that did not arrive.
	 */
	archiveAttempt: { page: number; cursor: string };
	archiveError: string | null;
	isEarlierLoading: boolean;
	/** Why "Show earlier work" failed, shown beside it. Never `error`: a failed
	 * fetch of the oldest rows must not blank the list the user is reading. */
	earlierError: string | null;
	/**
	 * Whether the page on screen may no longer say what the server would: a
	 * closed story it does not hold has been pushed, or the whole of `Current`
	 * has been handed back (see `markArchiveStale`).
	 *
	 * The archive is fetched and never pushed to, and §4.3 settles what a close
	 * does to a page someone is reading: nothing — "it is gone the next time the
	 * page is loaded". This is what makes that sentence true. Without it the
	 * page's lifetime is the *subscription's*, not the visit's, so a work that
	 * closed after the archive was first opened reached neither half of the
	 * screen — gone from `Current` because it is closed, absent from the archive
	 * because the archive is only ever fetched — until the user reloaded the
	 * app. That is the whole of the reported bug.
	 */
	archiveStale: boolean;
	/**
	 * Bumped every time a subscription is bound to the paging actions.
	 *
	 * The archive is fetched on demand, so something has to ask for the first
	 * page again after a resubscribe — and "the segment is open and no page has
	 * landed" is not enough on its own: it is already true at the moment the old
	 * subscription is thrown away, and re-asking then would fetch against the id
	 * that just turned out to be dead, forever. This says *which* subscription
	 * the absence belongs to.
	 */
	pagingGeneration: number;
}

interface WorkActions {
	/** Replaces the `Current` segment: a snapshot, a resync, or the uncapped
	 * answer to "Show earlier work". */
	setWorks: (works: WorkListItem[], hidden?: WorkListHidden) => void;
	updateWorks: (updater: (old: WorkListItem[]) => WorkListItem[]) => void;
	setError: (error: string) => void;
	beginArchiveLoad: (page: number, cursor: string) => void;
	setArchivePage: (
		page: number,
		cursor: string,
		items: WorkListItem[],
		nextCursor: string | null,
	) => void;
	failArchiveLoad: (message: string) => void;
	beginEarlierLoad: () => void;
	failEarlierLoad: (message: string) => void;
	/**
	 * Puts the archive back to "no page has landed", and cancels both fetches.
	 *
	 * For the one failure neither of them can retry: the subscription they were
	 * served against is gone, so the list being paged no longer exists. What
	 * comes back is a first page, at the cost of the reader's depth — the same
	 * cost a reconnect already pays.
	 */
	resubscribing: () => void;
	/**
	 * Takes a pushed row to the archive, which can mean one of two things and
	 * never a third: a row already on the page stays accurate while the user
	 * reads it, and a closed story that is *not* on it marks the page stale.
	 * Neither adds or moves a row — the archive is fetched, never pushed to
	 * (§4.3).
	 */
	updateArchiveRow: (row: WorkListItem) => void;
	/**
	 * Records that the page on screen may have missed something, without saying
	 * what.
	 *
	 * For the two moments that replace the `Current` segment wholesale — a
	 * subscription's snapshot, and a resync after dropped events. Neither says a
	 * word about closed work (`Current` holds none), so a work that closed while
	 * the client was disconnected, or during the gap a resync exists to paper
	 * over, reaches the archive through no other door.
	 */
	markArchiveStale: () => void;
	/** Drops a deleted work from the archive page it is on. A page is a window,
	 * not a quota: it stays one row short until the user moves. */
	removeFromArchive: (workId: string) => void;
	reset: () => void;
}

export type WorkStore = WorkState & WorkActions;

// A function, not a constant: the cursor stack is an array, and one shared
// instance handed to every reset is an array two resets can disagree about.
const initialArchive = () => ({
	archive: [] as WorkListItem[],
	archiveCursors: [""],
	archivePage: 0,
	archiveNextCursor: null as string | null,
	archiveLoaded: false,
	isArchiveLoading: false,
	archiveAttempt: { page: 0, cursor: "" },
	archiveError: null as string | null,
	isEarlierLoading: false,
	earlierError: null as string | null,
	archiveStale: false,
});

export const useWorkStore = create<WorkStore>((set, get) => ({
	works: [],
	hidden: NOTHING_HIDDEN,
	isLoading: true,
	error: null,
	pagingGeneration: 0,
	...initialArchive(),
	setWorks: (works, hidden = NOTHING_HIDDEN) =>
		set({
			works: works.map(normalizeWorkRow),
			hidden,
			isLoading: false,
			error: null,
			isEarlierLoading: false,
			earlierError: null,
		}),
	updateWorks: (updater) =>
		set((state) => ({ works: updater(state.works).map(normalizeWorkRow) })),
	setError: (error) => set({ isLoading: false, error }),
	beginArchiveLoad: (page, cursor) =>
		set({
			isArchiveLoading: true,
			archiveAttempt: { page, cursor },
			archiveError: null,
			// Cleared as the request goes out, not as its answer lands: the server
			// cuts the page when it reads, so a work that closes while the request
			// is in flight is not in the answer — and clearing on arrival would
			// swallow it.
			archiveStale: false,
		}),
	setArchivePage: (page, cursor, items, nextCursor) =>
		set((state) => {
			// The walked cursors are truncated to the page that just landed, so
			// stepping back and then forward again cannot leave a stale cursor
			// from a deeper walk in the stack.
			const cursors = state.archiveCursors.slice(0, page);
			cursors[page] = cursor;
			return {
				archive: items.map(normalizeWorkRow),
				archiveCursors: cursors,
				archivePage: page,
				archiveNextCursor: nextCursor,
				archiveLoaded: true,
				isArchiveLoading: false,
				archiveError: null,
			};
		}),
	failArchiveLoad: (message) =>
		set({ isArchiveLoading: false, archiveError: message }),
	beginEarlierLoad: () => set({ isEarlierLoading: true, earlierError: null }),
	failEarlierLoad: (message) =>
		set({ isEarlierLoading: false, earlierError: message }),
	resubscribing: () => set(initialArchive()),
	// Both leave the store untouched when the row is not on the page, rather
	// than writing an unchanged value: every work change reaches them, and most
	// projects have no archive page open at all.
	updateArchiveRow: (row) => {
		const { archive } = get();
		if (!archive.some((w) => w.id === row.id)) {
			// Only a closed story is a row of the archive, so only a closed story
			// can make a page that does not hold it wrong. An active story being
			// pushed on every turn must not, or the segment would re-fetch itself
			// all day for a list nobody is waiting on.
			if (row.type === "story" && row.status === "closed") {
				get().markArchiveStale();
			}
			return;
		}
		set({
			archive: archive.map((w) =>
				w.id === row.id ? normalizeWorkRow(row) : w,
			),
		});
	},
	markArchiveStale: () => {
		if (get().archiveStale) return;
		set({ archiveStale: true });
	},
	removeFromArchive: (workId) => {
		const { archive } = get();
		if (!archive.some((w) => w.id === workId)) return;
		set({ archive: archive.filter((w) => w.id !== workId) });
	},
	reset: () =>
		set({
			works: [],
			hidden: NOTHING_HIDDEN,
			isLoading: true,
			error: null,
			...initialArchive(),
		}),
}));

/**
 * One row as it arrived from the server, with its activity folded to a leaf this
 * build knows (see normalizeActivity).
 *
 * Both writers run it over what they are about to store, so the boundary is the
 * store itself rather than each call site's memory of it — and a row it leaves
 * alone is returned unchanged, so the rows React is diffing keep their identity.
 */
export function normalizeWorkRow(row: WorkListItem): WorkListItem {
	const activity = normalizeActivity(row.activity);
	return activity === row.activity ? row : { ...row, activity };
}

/** The only fields the verdict below reads off a work. */
type WorkNode = Pick<WorkListItem, "story_id" | "status">;

/**
 * Whether a work's worktree is already decided and can no longer change.
 *
 * A work that is no longer `open` is frozen: the backend only ever rewrites
 * works that are still `open`. An open task instead waits on its *story* — only
 * a story captures a worktree when it starts, and that same moment rewrites
 * every still-open task to match. So an open task is decided as soon as its
 * story has started, and undecided before that.
 *
 * One lookup and no walk: `story_id` is the whole of the hierarchy, so the item
 * above a task is a story and a story has nothing above it. A story missing
 * from the list (not synced yet) leaves the task itself as the answer, which is
 * `open`, which is the truthful "not decided".
 */
export function isWorktreeBound(
	works: WorkListItem[],
	work: WorkNode,
): boolean {
	if (work.status !== "open") return true;
	if (!work.story_id) return false;
	const story = works.find((w) => w.id === work.story_id);
	return story ? story.status !== "open" : false;
}

/**
 * The work list subscription the two fetches below are served against, as the
 * hook that owns its lifecycle last opened it.
 *
 * It is a module binding rather than a prop because the subscription is opened
 * in the app shell while the controls that page it are inside the project
 * overlay, and a second subscription opened just to reach its id would be a
 * second watcher on the server for one list.
 */
let paging: { id: string; onInvalid: () => void } | null = null;

export const workPagingActions = {
	bind: (id: string, onInvalid: () => void) => {
		paging = { id, onInvalid };
		useWorkStore.setState((state) => ({
			pagingGeneration: state.pagingGeneration + 1,
		}));
	},
	unbind: () => {
		paging = null;
	},

	/**
	 * Loads one page of the archive. `page` is an index into the cursors already
	 * walked — 0 is the first page — so stepping back re-asks with a cursor the
	 * client already used, and the server never has to page backwards.
	 */
	loadArchivePage: async (page: number, cursor: string) => {
		const subscription = paging;
		const store = useWorkStore.getState();
		if (!subscription || store.isArchiveLoading) return;

		store.beginArchiveLoad(page, cursor);
		try {
			const result = await wsActions.workListArchive(subscription.id, cursor);
			useWorkStore
				.getState()
				.setArchivePage(
					page,
					cursor,
					result.items,
					result.has_more ? (result.next_cursor ?? null) : null,
				);
		} catch (error) {
			// Invalid params is the one failure a Retry cannot fix: the
			// subscription is gone, or the cursor is not one this server handed
			// out. Both mean the list being paged no longer exists, so the answer
			// is a fresh subscription rather than a button that can only fail the
			// same way again.
			if (isInvalidParamsRejection(error)) {
				// Unbound before the resubscribe, so nothing asks the dead id for
				// the first page in the window between the two.
				workPagingActions.unbind();
				useWorkStore.getState().resubscribing();
				subscription.onInvalid();
				return;
			}
			useWorkStore
				.getState()
				.failArchiveLoad(`Failed to load the archive: ${reasonOf(error)}`);
		}
	},

	/**
	 * Lifts the cap on both capped groups — either group's control asks for the
	 * same thing. A cap is not a page: this replaces the `Current` segment with
	 * the whole of it, and there is no second press.
	 */
	loadEarlier: async () => {
		const subscription = paging;
		const store = useWorkStore.getState();
		if (!subscription || store.isEarlierLoading) return;

		store.beginEarlierLoad();
		try {
			const result = await wsActions.workListEarlier(subscription.id);
			// Nothing hidden either side of it: one press lifts both caps, so
			// both controls go at once.
			useWorkStore.getState().setWorks(result.items);
		} catch (error) {
			if (isInvalidParamsRejection(error)) {
				workPagingActions.unbind();
				useWorkStore.getState().resubscribing();
				subscription.onInvalid();
				return;
			}
			useWorkStore
				.getState()
				.failEarlierLoad(`Failed to load earlier work: ${reasonOf(error)}`);
		}
	},
};

function reasonOf(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Unknown error";
}
