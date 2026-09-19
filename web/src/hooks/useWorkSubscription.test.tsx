import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkStore } from "../lib/workStore";
import type { WorkListChangedNotification, WorkListItem } from "../types/work";
import { useWorkSubscription } from "./useWorkSubscription";

const row = (overrides: Partial<WorkListItem> = {}): WorkListItem => ({
	id: "w1",
	type: "story",
	title: "Story",
	status: "open",
	activity: "open",
	updated_at: "2026-03-04T00:00:00Z",
	...overrides,
});

let notify: ((p: WorkListChangedNotification) => void) | null = null;
let snapshot: {
	items: WorkListItem[];
	stopped_hidden?: number;
	open_hidden?: number;
} = {
	items: [],
};

const mockSubscribe = vi.fn(
	async (callback: (p: WorkListChangedNotification) => void) => {
		notify = callback;
		return { id: "watch-1", initial: snapshot };
	},
);
const mockUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/wsStore")>()),
	useWSStore: vi.fn((selector) =>
		selector({
			status: "connected",
			actions: {
				workListSubscribe: mockSubscribe,
				workListUnsubscribe: mockUnsubscribe,
			},
		}),
	),
}));

async function subscribed() {
	const view = renderHook(() => useWorkSubscription(true));
	await waitFor(() => expect(notify).not.toBeNull());
	return view;
}

describe("useWorkSubscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		notify = null;
		snapshot = { items: [] };
		useWorkStore.getState().reset();
	});

	it("takes the count of what the snapshot held back", async () => {
		snapshot = { items: [row()], stopped_hidden: 4, open_hidden: 12 };

		await subscribed();

		await waitFor(() =>
			expect(useWorkStore.getState().hidden).toEqual({ stopped: 4, open: 12 }),
		);
	});

	// The row the cap can hide is the row nobody drew — but a work that starts
	// needing a person is news whether or not the client was sent it, and
	// dropping that update is exactly how the Project tab's attention dot would
	// go dark on a project that needs one (docs/list-paging-ui.md §2.1).
	it("takes in an update for a work it was never sent", async () => {
		snapshot = { items: [row({ id: "shown" })], open_hidden: 3 };
		await subscribed();
		await waitFor(() => expect(useWorkStore.getState().works).toHaveLength(1));

		act(() => {
			notify?.({
				id: "watch-1",
				operation: "update",
				work: row({
					id: "hidden",
					status: "active",
					activity: "needs_message",
				}),
			});
		});

		expect(useWorkStore.getState().works.map((w) => w.id)).toEqual([
			"shown",
			"hidden",
		]);
	});

	it("updates a row it already holds in place", async () => {
		snapshot = { items: [row({ id: "a" }), row({ id: "b" })] };
		await subscribed();
		await waitFor(() => expect(useWorkStore.getState().works).toHaveLength(2));

		act(() => {
			notify?.({
				id: "watch-1",
				operation: "update",
				work: row({ id: "a", title: "Renamed" }),
			});
		});

		const works = useWorkStore.getState().works;
		expect(works.map((w) => w.id)).toEqual(["a", "b"]);
		expect(works[0].title).toBe("Renamed");
	});

	// §4.3: nothing lands in the archive unasked — except a change to a row the
	// user is already looking at, which stays accurate.
	it("keeps a row of the archive page accurate without adding one", async () => {
		snapshot = { items: [] };
		await subscribed();
		const closed = row({ id: "old", status: "closed", activity: "closed" });
		act(() => {
			useWorkStore.getState().setArchivePage(0, "", [closed], null);
		});

		act(() => {
			notify?.({
				id: "watch-1",
				operation: "update",
				work: { ...closed, title: "Renamed after the fact" },
			});
			notify?.({
				id: "watch-1",
				operation: "update",
				work: row({ id: "another", status: "closed", activity: "closed" }),
			});
		});

		const state = useWorkStore.getState();
		expect(state.archive.map((w) => w.id)).toEqual(["old"]);
		expect(state.archive[0].title).toBe("Renamed after the fact");
		// The closed story it did not add is not dropped on the floor either: the
		// page it belongs to is marked stale, which is what re-asks for it.
		expect(state.archiveStale).toBe(true);
	});

	it("drops a deleted work from the archive page it is on", async () => {
		snapshot = { items: [] };
		await subscribed();
		act(() => {
			useWorkStore
				.getState()
				.setArchivePage(
					0,
					"",
					[row({ id: "old", status: "closed", activity: "closed" })],
					null,
				);
		});

		act(() => {
			notify?.({ id: "watch-1", operation: "delete", workId: "old" });
		});

		expect(useWorkStore.getState().archive).toEqual([]);
	});

	// `Current` holds no closed work, so neither of the two wholesale replacements
	// below says a word about the archive — and a work that closed inside the gap
	// each of them exists to cover would reach it through no other door.
	it("treats a resync as a reason to re-read the archive", async () => {
		snapshot = { items: [] };
		await subscribed();
		act(() => {
			useWorkStore
				.getState()
				.setArchivePage(
					0,
					"",
					[row({ id: "old", status: "closed", activity: "closed" })],
					null,
				);
			// The subscription's own snapshot has already marked it once (below);
			// this is the page standing fresh, which is what a sync has to spoil.
			useWorkStore.setState({ archiveStale: false });
		});
		expect(useWorkStore.getState().archiveStale).toBe(false);

		act(() => {
			notify?.({ id: "watch-1", operation: "sync", works: [] });
		});

		expect(useWorkStore.getState().archiveStale).toBe(true);
	});

	// A reconnect opens a new subscription over a page the old one fetched.
	it("treats a snapshot the same way", async () => {
		snapshot = { items: [] };
		await subscribed();

		await waitFor(() =>
			expect(useWorkStore.getState().archiveStale).toBe(true),
		);
	});

	it("takes the held-back count from a resync too", async () => {
		snapshot = { items: [row()], open_hidden: 5 };
		await subscribed();
		await waitFor(() => expect(useWorkStore.getState().hidden.open).toBe(5));

		act(() => {
			notify?.({
				id: "watch-1",
				operation: "sync",
				works: [row({ id: "a" })],
				stopped_hidden: 2,
				open_hidden: 9,
			});
		});

		expect(useWorkStore.getState().hidden).toEqual({ stopped: 2, open: 9 });
	});
});
