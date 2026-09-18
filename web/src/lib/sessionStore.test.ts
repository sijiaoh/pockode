import { beforeEach, describe, expect, it } from "vitest";
import { makeSessionListItem } from "../test/sessionFixtures";
import { prependSession, useSessionStore } from "./sessionStore";

const mockSession = (id: string, title = "Test") =>
	makeSessionListItem({ id, title });

const page = (
	sessions: ReturnType<typeof mockSession>[],
	nextCursor = null as string | null,
) => ({ sessions, nextCursor, hasUnread: false });

describe("prependSession", () => {
	it("adds session to the beginning", () => {
		const sessions = [mockSession("1"), mockSession("2")];
		const newSession = mockSession("3");

		const result = prependSession(sessions, newSession);

		expect(result[0].id).toBe("3");
		expect(result.length).toBe(3);
	});

	it("removes duplicate and prepends", () => {
		const sessions = [mockSession("1"), mockSession("2")];
		const updatedSession = mockSession("2", "Updated");

		const result = prependSession(sessions, updatedSession);

		expect(result.length).toBe(2);
		expect(result[0].id).toBe("2");
		expect(result[0].title).toBe("Updated");
	});

	it("handles empty list", () => {
		const result = prependSession([], mockSession("1"));

		expect(result.length).toBe(1);
		expect(result[0].id).toBe("1");
	});
});

describe("useSessionStore", () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
	});

	describe("setSessions", () => {
		it("sets sessions and updates loading state", () => {
			const sessions = [mockSession("1")];

			useSessionStore.getState().setSessions(page(sessions));

			const state = useSessionStore.getState();
			expect(state.sessions).toEqual(sessions);
			expect(state.isLoading).toBe(false);
			expect(state.isSuccess).toBe(true);
		});

		it("carries the whole list's unread flag rather than deriving one", () => {
			// Every row on this page is read; the unread one is further down a list
			// the user has not scrolled to.
			useSessionStore
				.getState()
				.setSessions({ ...page([mockSession("1")]), hasUnread: true });

			expect(useSessionStore.getState().hasUnread).toBe(true);
		});

		// Past the resync cap the list comes back shorter than what the reader had.
		// The browser clamps them to its new end, where an armed sentinel would ask
		// for the next page at once and undo the cap.
		it("disarms auto-loading when a resync shrinks the list", () => {
			useSessionStore.setState({
				sessions: [mockSession("1"), mockSession("2"), mockSession("3")],
			});

			useSessionStore.getState().setSessions(page([mockSession("1")]), true);

			expect(useSessionStore.getState().autoLoad).toBe(false);
		});

		// A new list that happens to be shorter — a flipped filter, another
		// worktree — says nothing about where the reader was in the old one.
		it("keeps auto-loading armed when a shorter snapshot replaces the list", () => {
			useSessionStore.setState({
				sessions: [mockSession("1"), mockSession("2"), mockSession("3")],
				autoLoad: false,
			});

			useSessionStore.getState().setSessions(page([mockSession("1")]));

			expect(useSessionStore.getState().autoLoad).toBe(true);
		});
	});

	describe("appendSessions", () => {
		it("appends a page and remembers where the next one starts", () => {
			useSessionStore.getState().setSessions(page([mockSession("1")], "c1"));
			const { generation } = useSessionStore.getState();

			useSessionStore
				.getState()
				.appendSessions(generation, [mockSession("2")], "c2");

			const state = useSessionStore.getState();
			expect(state.sessions.map((s) => s.id)).toEqual(["1", "2"]);
			expect(state.nextCursor).toBe("c2");
			expect(state.hasPaged).toBe(true);
		});

		// The cursor removes the systematic error, not every race: a session
		// touched between two requests moves in the sort order.
		it("drops a row it already holds", () => {
			useSessionStore.getState().setSessions(page([mockSession("1")], "c1"));
			const { generation } = useSessionStore.getState();

			useSessionStore
				.getState()
				.appendSessions(generation, [mockSession("1"), mockSession("2")], null);

			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([
				"1",
				"2",
			]);
		});

		// Auto-loading is only ever off because something transient turned it
		// off, and the button is the way back from both. Left off, one resync
		// deep in a list would quietly turn the rest of the session into a list
		// that has to be clicked down a page at a time — with nothing on screen
		// saying so.
		it("re-arms auto-loading on the page the user asked for by hand", () => {
			useSessionStore.getState().setSessions(page([mockSession("1")], "c1"));
			useSessionStore.setState({ autoLoad: false });
			const { generation } = useSessionStore.getState();

			useSessionStore
				.getState()
				.appendSessions(generation, [mockSession("2")], "c2");

			expect(useSessionStore.getState().autoLoad).toBe(true);
		});

		// A page in flight across a resync or a filter change belongs to a list
		// that no longer exists.
		it("ignores a page from a list that has been replaced", () => {
			useSessionStore.getState().setSessions(page([mockSession("1")], "c1"));
			const stale = useSessionStore.getState().generation;
			useSessionStore.getState().setSessions(page([mockSession("9")], "c9"));

			useSessionStore
				.getState()
				.appendSessions(stale, [mockSession("2")], null);

			expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([
				"9",
			]);
		});
	});

	describe("failLoadMore", () => {
		it("reports the failure and stops the list fetching by itself", () => {
			useSessionStore.getState().setSessions(page([mockSession("1")], "c1"));
			const { generation } = useSessionStore.getState();

			useSessionStore.getState().failLoadMore(generation, "boom");

			let state = useSessionStore.getState();
			expect(state.pageError).toBe("boom");
			expect(state.autoLoad).toBe(false);
			expect(state.isLoadingMore).toBe(false);

			useSessionStore.getState().retryLoadMore();

			state = useSessionStore.getState();
			expect(state.pageError).toBeNull();
			expect(state.autoLoad).toBe(true);
		});
	});

	describe("updateSessions", () => {
		it("updates sessions with updater function", () => {
			useSessionStore.setState({ sessions: [mockSession("1")] });

			useSessionStore
				.getState()
				.updateSessions((old) => [...old, mockSession("2")]);

			expect(useSessionStore.getState().sessions.length).toBe(2);
		});
	});

	describe("beginReload", () => {
		it("keeps sessions and isLoading but marks the list as reloading", () => {
			useSessionStore.setState({
				sessions: [mockSession("1")],
				isLoading: false,
				isSuccess: true,
				isReloading: false,
			});

			useSessionStore.getState().beginReload();

			const state = useSessionStore.getState();
			// Data is retained (shown as placeholder) and no spinner (isLoading stays
			// false), but isSuccess is cleared so redirect logic waits for new data.
			expect(state.sessions.length).toBe(1);
			expect(state.isLoading).toBe(false);
			expect(state.isSuccess).toBe(false);
			expect(state.isReloading).toBe(true);
		});
	});

	describe("reset", () => {
		it("resets to initial state", () => {
			useSessionStore.setState({
				sessions: [mockSession("1")],
				isLoading: false,
				isSuccess: true,
			});

			useSessionStore.getState().reset();

			const state = useSessionStore.getState();
			expect(state.sessions).toEqual([]);
			expect(state.isLoading).toBe(false);
			expect(state.isSuccess).toBe(false);
		});
	});
});
