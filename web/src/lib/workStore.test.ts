import { renderHook } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	WorkListArchiveResult,
	WorkListEarlierResult,
	WorkListItem,
} from "../types/work";
import {
	useWorkNeedsAttention,
	useWorkStore,
	workPagingActions,
} from "./workStore";

const mockArchive = vi.fn(
	async (_id: string, _cursor: string): Promise<WorkListArchiveResult> => ({
		items: [],
		has_more: false,
	}),
);
const mockEarlier = vi.fn(
	async (_id: string): Promise<WorkListEarlierResult> => ({ items: [] }),
);

// The real module underneath, so `isInvalidParamsRejection` — which the two
// fetches read a recovery decision out of — is the one that ships.
vi.mock("./wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("./wsStore")>()),
	wsActions: {
		workListArchive: (id: string, cursor: string) => mockArchive(id, cursor),
		workListEarlier: (id: string) => mockEarlier(id),
	},
}));

const row = (overrides: Partial<WorkListItem> = {}): WorkListItem => ({
	id: "w1",
	type: "task",
	title: "Rewire the lifecycle",
	status: "active",
	activity: "running",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

describe("the work store's wire boundary", () => {
	beforeEach(() => {
		useWorkStore.getState().reset();
	});

	// A client talking to a newer server must not blank a row over a leaf it has
	// never heard of, and `idle` is the leaf that claims the least.
	it("folds an activity this build does not know to idle", () => {
		const unknown = { activity: "reticulating" } as unknown as WorkListItem;

		useWorkStore.getState().setWorks([row(unknown)]);

		expect(useWorkStore.getState().works[0].activity).toBe("idle");
	});

	// `in` would walk the prototype chain and let this through, and the view map
	// would then hand a row a function where its glyph should be.
	it("folds an inherited property name to idle as well", () => {
		useWorkStore
			.getState()
			.setWorks([row({ activity: "toString" as WorkListItem["activity"] })]);

		expect(useWorkStore.getState().works[0].activity).toBe("idle");
	});

	// The same boundary on the other writer: a row arriving as a change
	// notification goes through the store, not through the caller's memory of it.
	it("folds it on an update as well as on a full list", () => {
		useWorkStore.getState().setWorks([row()]);

		useWorkStore
			.getState()
			.updateWorks(() => [
				row({ activity: "who knows" as WorkListItem["activity"] }),
			]);

		expect(useWorkStore.getState().works[0].activity).toBe("idle");
	});

	// A row it leaves alone is returned unchanged, so the rows React is diffing
	// keep their identity across a notification that did not touch them.
	it("returns a recognised row as it arrived", () => {
		const untouched = row({ id: "w2", activity: "needs_permission" });

		useWorkStore.getState().setWorks([untouched]);

		expect(useWorkStore.getState().works[0]).toBe(untouched);
	});
});

describe("the archive page going stale", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkStore.getState().reset();
		workPagingActions.unbind();
	});

	const closedStory = (id: string) =>
		row({ id, type: "story", status: "closed", activity: "closed" });

	// The reported bug: a work closes, leaves `Current` because it is closed,
	// and never reaches the archive because the archive is only ever fetched.
	// Nothing was wrong with the push — what was missing was anything that made
	// the page on screen ask again.
	it("marks the page stale when a story closes off it", () => {
		useWorkStore.getState().setArchivePage(0, "", [closedStory("old")], null);

		useWorkStore.getState().updateArchiveRow(closedStory("just-finished"));

		const state = useWorkStore.getState();
		expect(state.archiveStale).toBe(true);
		// Stale, not inserted: the archive is a page, and a row landing in it
		// unasked is a page the server never cut (docs/list-paging-ui.md §4.3).
		expect(state.archive.map((w) => w.id)).toEqual(["old"]);
	});

	// A running story is pushed on every turn. If those marked the page stale it
	// would re-fetch itself all day for a list nobody is waiting on.
	it("leaves it alone for rows that are not archive rows", () => {
		useWorkStore.getState().setArchivePage(0, "", [closedStory("old")], null);

		useWorkStore.getState().updateArchiveRow(row({ id: "busy" }));
		useWorkStore
			.getState()
			.updateArchiveRow(row({ id: "story", type: "story" }));
		useWorkStore
			.getState()
			.updateArchiveRow(row({ id: "task", status: "closed" }));

		expect(useWorkStore.getState().archiveStale).toBe(false);
	});

	it("keeps a row it does hold accurate rather than marking it stale", () => {
		useWorkStore.getState().setArchivePage(0, "", [closedStory("old")], null);

		useWorkStore
			.getState()
			.updateArchiveRow({ ...closedStory("old"), title: "Renamed" });

		const state = useWorkStore.getState();
		expect(state.archiveStale).toBe(false);
		expect(state.archive[0].title).toBe("Renamed");
	});

	// The server cuts the page when it reads the request, so a work that closes
	// while the request is in flight is not in the answer. Clearing on arrival
	// would swallow it and put the bug back.
	it("survives a fetch that went out before it", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		useWorkStore.getState().setArchivePage(0, "", [closedStory("old")], null);
		mockArchive.mockImplementationOnce(async () => {
			useWorkStore.getState().updateArchiveRow(closedStory("just-finished"));
			return { items: [closedStory("old")], has_more: false };
		});

		await workPagingActions.loadArchivePage(0, "");

		expect(useWorkStore.getState().archiveStale).toBe(true);
	});

	it("is answered by the page the fetch brings back", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		useWorkStore.getState().setArchivePage(0, "", [closedStory("old")], null);
		useWorkStore.getState().updateArchiveRow(closedStory("just-finished"));
		mockArchive.mockResolvedValueOnce({
			items: [closedStory("just-finished"), closedStory("old")],
			has_more: false,
		});

		await workPagingActions.loadArchivePage(0, "");

		const state = useWorkStore.getState();
		expect(state.archiveStale).toBe(false);
		expect(state.archive.map((w) => w.id)).toEqual(["just-finished", "old"]);
	});
});

describe("the work list's two fetches", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkStore.getState().reset();
		workPagingActions.unbind();
	});

	const closed = (id: string) =>
		row({ id, type: "story", status: "closed", activity: "closed" });

	it("does nothing at all before a subscription is bound", async () => {
		await workPagingActions.loadArchivePage(0, "");

		expect(mockArchive).not.toHaveBeenCalled();
		expect(useWorkStore.getState().archiveLoaded).toBe(false);
	});

	it("walks to the next page with the cursor the last one handed back", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockResolvedValueOnce({
			items: [closed("a")],
			next_cursor: "cursor-1",
			has_more: true,
		});

		await workPagingActions.loadArchivePage(0, "");
		expect(useWorkStore.getState().archiveNextCursor).toBe("cursor-1");

		mockArchive.mockResolvedValueOnce({
			items: [closed("b")],
			has_more: false,
		});
		await workPagingActions.loadArchivePage(1, "cursor-1");

		expect(mockArchive).toHaveBeenLastCalledWith("watch-1", "cursor-1");
		const state = useWorkStore.getState();
		expect(state.archivePage).toBe(1);
		expect(state.archiveNextCursor).toBeNull();
		// Walking back is handing back a cursor already used, so page 1's is kept.
		expect(state.archiveCursors).toEqual(["", "cursor-1"]);
	});

	// A page is a window, not an accumulation: the rows on screen are the page,
	// and the one before it is gone.
	it("replaces the page rather than appending to it", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockResolvedValueOnce({
			items: [closed("a")],
			next_cursor: "cursor-1",
			has_more: true,
		});
		await workPagingActions.loadArchivePage(0, "");

		mockArchive.mockResolvedValueOnce({
			items: [closed("b")],
			has_more: false,
		});
		await workPagingActions.loadArchivePage(1, "cursor-1");

		expect(useWorkStore.getState().archive.map((w) => w.id)).toEqual(["b"]);
	});

	// A cursor from a deeper walk must not survive a step back and a step
	// forward, or the second "Older" would skip the page it just left.
	it("forgets the cursors past the page that landed", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockResolvedValue({
			items: [closed("a")],
			next_cursor: "deep",
			has_more: true,
		});
		await workPagingActions.loadArchivePage(0, "");
		await workPagingActions.loadArchivePage(1, "cursor-1");
		await workPagingActions.loadArchivePage(2, "cursor-2");

		await workPagingActions.loadArchivePage(1, "cursor-1");

		expect(useWorkStore.getState().archiveCursors).toEqual(["", "cursor-1"]);
	});

	it("reports a failed page without pretending the archive is empty", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockRejectedValueOnce(new Error("socket closed"));

		await workPagingActions.loadArchivePage(0, "");

		const state = useWorkStore.getState();
		expect(state.archiveError).toContain("socket closed");
		expect(state.isArchiveLoading).toBe(false);
		expect(state.archiveLoaded).toBe(false);
	});

	// Invalid params is the one failure a Retry cannot fix: the list being paged
	// no longer exists, so the answer is a fresh subscription.
	it("resubscribes rather than offering a Retry that can only fail", async () => {
		const onInvalid = vi.fn();
		workPagingActions.bind("watch-1", onInvalid);
		mockArchive.mockRejectedValueOnce(
			new JSONRPCErrorException(
				"no such subscription",
				JSONRPCErrorCode.InvalidParams,
			),
		);

		await workPagingActions.loadArchivePage(0, "");

		expect(onInvalid).toHaveBeenCalled();
		expect(useWorkStore.getState().archiveError).toBeNull();
	});

	// Leaving the flag up is what would make the pager a permanently disabled
	// row and every later page a no-op — the recovery has to clear the fetch it
	// is recovering from.
	it("leaves nothing in flight after a resubscribe", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockRejectedValueOnce(
			new JSONRPCErrorException("gone", JSONRPCErrorCode.InvalidParams),
		);
		await workPagingActions.loadArchivePage(0, "");

		const state = useWorkStore.getState();
		expect(state.isArchiveLoading).toBe(false);
		expect(state.archiveLoaded).toBe(false);
		expect(state.archivePage).toBe(0);
	});

	// And nothing may ask the dead id for that first page in the window before
	// the new subscription lands, or the recovery is a request loop.
	it("asks nothing more of the subscription that just turned out to be dead", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockRejectedValueOnce(
			new JSONRPCErrorException("gone", JSONRPCErrorCode.InvalidParams),
		);
		await workPagingActions.loadArchivePage(0, "");
		mockArchive.mockClear();

		await workPagingActions.loadArchivePage(0, "");

		expect(mockArchive).not.toHaveBeenCalled();
	});

	it("bumps the generation on every binding, which is what re-asks", async () => {
		const before = useWorkStore.getState().pagingGeneration;

		workPagingActions.bind("watch-1", vi.fn());

		expect(useWorkStore.getState().pagingGeneration).toBe(before + 1);
	});

	// Retry has to ask for the page that failed, which after a failed "Older" is
	// not the page still on screen.
	it("remembers which page failed", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		mockArchive.mockResolvedValueOnce({
			items: [closed("a")],
			next_cursor: "cursor-1",
			has_more: true,
		});
		await workPagingActions.loadArchivePage(0, "");

		mockArchive.mockRejectedValueOnce(new Error("socket closed"));
		await workPagingActions.loadArchivePage(1, "cursor-1");

		const state = useWorkStore.getState();
		expect(state.archiveAttempt).toEqual({ page: 1, cursor: "cursor-1" });
		// The rows the user was reading are still there.
		expect(state.archive.map((w) => w.id)).toEqual(["a"]);
		expect(state.archivePage).toBe(0);
	});

	it("clears the earlier fetch when it is the one that finds the subscription gone", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		useWorkStore
			.getState()
			.setWorks([row({ id: "s1" })], { stopped: 0, open: 7 });
		mockEarlier.mockRejectedValueOnce(
			new JSONRPCErrorException("gone", JSONRPCErrorCode.InvalidParams),
		);

		await workPagingActions.loadEarlier();

		const state = useWorkStore.getState();
		expect(state.isEarlierLoading).toBe(false);
		expect(state.earlierError).toBeNull();
	});

	// A cap is not a page: one press replaces the segment with the whole of it,
	// and the control that asked is gone afterwards.
	it("lifts both group caps in one call", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		useWorkStore
			.getState()
			.setWorks([row({ id: "s1" })], { stopped: 4, open: 7 });
		mockEarlier.mockResolvedValueOnce({
			items: [row({ id: "s0" }), row({ id: "s1" })],
		});

		await workPagingActions.loadEarlier();

		const state = useWorkStore.getState();
		expect(state.works.map((w) => w.id)).toEqual(["s0", "s1"]);
		// Both, from one press: it is the lid coming off the segment, not a page.
		expect(state.hidden).toEqual({ stopped: 0, open: 0 });
	});

	it("keeps the list on screen when showing earlier work fails", async () => {
		workPagingActions.bind("watch-1", vi.fn());
		useWorkStore
			.getState()
			.setWorks([row({ id: "s1" })], { stopped: 0, open: 7 });
		mockEarlier.mockRejectedValueOnce(new Error("socket closed"));

		await workPagingActions.loadEarlier();

		const state = useWorkStore.getState();
		expect(state.earlierError).toContain("socket closed");
		// Not `error`: that one replaces the list with a failure message.
		expect(state.error).toBeNull();
		expect(state.works).toHaveLength(1);
		expect(state.hidden).toEqual({ stopped: 0, open: 7 });
	});
});

describe("who is waiting on the user", () => {
	beforeEach(() => {
		useWorkStore.getState().reset();
	});

	const hasAttention = () =>
		renderHook(() => useWorkNeedsAttention()).result.current;

	it("counts a work whose agent is blocked on a permission", () => {
		useWorkStore
			.getState()
			.setWorks([
				row({ id: "w1" }),
				row({ id: "w2", activity: "needs_permission" }),
			]);

		expect(hasAttention()).toBe(true);
	});

	it("counts a running work that has posted a question nobody answered", () => {
		// The two dimensions are independent: an agent goes on running after it
		// asks, so the activity alone would never say the user owes it anything.
		useWorkStore
			.getState()
			.setWorks([row({ activity: "running", unanswered_questions: 1 })]);

		expect(hasAttention()).toBe(true);
	});

	it("leaves out a stopped work nobody is waiting on", () => {
		// Handed back to a person, but not waiting on one — and the dot means the
		// second thing (docs/lifecycle-ui.md §4).
		useWorkStore
			.getState()
			.setWorks([row({ status: "stopped", activity: "stopped" })]);

		expect(hasAttention()).toBe(false);
	});

	it("leaves out the states nobody can act on", () => {
		useWorkStore
			.getState()
			.setWorks([
				row({ activity: "background" }),
				row({ id: "w2", activity: "waiting_children" }),
				row({ id: "w3", activity: "idle" }),
			]);

		expect(hasAttention()).toBe(false);
	});
});
