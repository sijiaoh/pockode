import { act, renderHook, waitFor } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../lib/sessionStore";
import { resetWorktreeStore, worktreeActions } from "../lib/worktreeStore";
import { makeSessionListItem } from "../test/sessionFixtures";
import type {
	SessionListChangedNotification,
	SessionListItem,
	SessionListPageResult,
} from "../types/message";
import { useSessionSubscription } from "./useSessionSubscription";

const mockSessionItem = (id: string, title = "Test") =>
	makeSessionListItem({ id, title });

let notificationCallback: ((p: SessionListChangedNotification) => void) | null =
	null;
let mockSessions: SessionListItem[] = [];
let mockNextCursor: string | null = null;
let mockHasUnread = false;
let mockStatus = "connected";

const mockSubscribe = vi.fn(
	async (
		callback: (p: SessionListChangedNotification) => void,
		_excludeWorkSessions?: boolean,
	) => {
		notificationCallback = callback;
		return {
			id: "watch-1",
			initial: {
				sessions: mockSessions,
				next_cursor: mockNextCursor ?? undefined,
				has_more: mockNextCursor !== null,
				has_unread: mockHasUnread,
			},
		};
	},
);
const mockUnsubscribe = vi.fn();
const mockPage = vi.fn(
	async (_id: string, _cursor: string): Promise<SessionListPageResult> => ({
		sessions: [],
		has_more: false,
	}),
);

// The real module underneath, so `isInvalidParamsRejection` — which the hook
// reads a recovery decision out of — is the one that ships, not a copy of it.
vi.mock("../lib/wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/wsStore")>()),
	useWSStore: vi.fn((selector) => {
		const state = {
			status: mockStatus,
			actions: {
				sessionListSubscribe: mockSubscribe,
				sessionListUnsubscribe: mockUnsubscribe,
				sessionListPage: mockPage,
			},
		};
		return selector(state);
	}),
}));

describe("useSessionSubscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		notificationCallback = null;
		mockSessions = [];
		mockNextCursor = null;
		mockHasUnread = false;
		mockStatus = "connected";
		resetWorktreeStore();
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
			isReloading: false,
		});
	});

	describe("subscription lifecycle", () => {
		it("subscribes when enabled and connected", async () => {
			mockSessions = [mockSessionItem("1")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});
			expect(useSessionStore.getState().sessions.length).toBe(1);
		});

		it("does not subscribe when disabled", async () => {
			renderHook(() => useSessionSubscription(false, false));

			await new Promise((r) => setTimeout(r, 50));

			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("does not subscribe when disconnected", async () => {
			mockStatus = "disconnected";

			renderHook(() => useSessionSubscription(true, false));

			await new Promise((r) => setTimeout(r, 50));

			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("unsubscribes on unmount", async () => {
			mockSessions = [mockSessionItem("1")];

			const { unmount } = renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});

			unmount();

			expect(mockUnsubscribe).toHaveBeenCalledWith("watch-1");
		});
	});

	describe("notification handling", () => {
		it("handles create notification", async () => {
			mockSessions = [mockSessionItem("1")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "create",
					session: mockSessionItem("2"),
				});
			});

			expect(useSessionStore.getState().sessions.length).toBe(2);
			expect(useSessionStore.getState().sessions[0].id).toBe("2");
		});

		it("handles update notification", async () => {
			mockSessions = [mockSessionItem("1", "Old")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions[0].title).toBe("Old");
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSessionItem("1", "New"),
				});
			});

			expect(useSessionStore.getState().sessions[0].title).toBe("New");
		});

		// The promise the whole design rests on: recency is recomputed when a page
		// is *loaded*, never when an event arrives (docs/list-paging-ui.md §3.2,
		// check 4). Every other update case here holds one row, where updating in
		// place and moving to the top are indistinguishable — so this is the one
		// that would notice `update` being handed the `create` branch's prepend.
		it("leaves an updated row where it is instead of moving it", async () => {
			mockSessions = [
				mockSessionItem("1"),
				mockSessionItem("2", "Old"),
				mockSessionItem("3"),
			];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(3);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSessionItem("2", "New"),
				});
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions.map((s) => s.id)).toEqual(["1", "2", "3"]);
			expect(sessions[1].title).toBe("New");
		});

		// The deliberate opposite of the work list, which upserts a row it was
		// never sent. There the absence is a held-back row and dropping it would
		// darken the attention dot; here it is a row further down a list nobody
		// has scrolled to, and inserting it would put it at a position the sort
		// order does not agree with. The badge that *does* have to survive the
		// absence rides on the notification instead (`has_unread`).
		it("ignores an update for a session below the loaded range", async () => {
			mockSessions = [mockSessionItem("1")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSessionItem("unloaded"),
					has_unread: true,
				});
			});

			const state = useSessionStore.getState();
			expect(state.sessions.map((s) => s.id)).toEqual(["1"]);
			expect(state.hasUnread).toBe(true);
		});

		it("reflects server-side unread flag from update notification", async () => {
			mockSessions = [mockSessionItem("1")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: { ...mockSessionItem("1"), unread: true },
				});
			});

			expect(useSessionStore.getState().sessions[0].unread).toBe(true);
		});

		it("handles delete notification", async () => {
			mockSessions = [mockSessionItem("1"), mockSessionItem("2")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(2);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "delete",
					sessionId: "1",
				});
			});

			expect(useSessionStore.getState().sessions.length).toBe(1);
			expect(useSessionStore.getState().sessions[0].id).toBe("2");
		});

		it("handles update notification with a turn change", async () => {
			mockSessions = [mockSessionItem("1")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions[0].turn.phase).toBe("idle");
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: {
						...mockSessionItem("1"),
						turn: {
							phase: "running",
							open: true,
							since: "2024-01-01T00:00:00Z",
						},
					},
				});
			});

			expect(useSessionStore.getState().sessions[0].turn.phase).toBe("running");
		});
	});

	describe("worktree switch", () => {
		it("keeps previous sessions during switch and swaps in the new list", async () => {
			mockSessions = [mockSessionItem("old")];

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});
			expect(useSessionStore.getState().isSuccess).toBe(true);

			// Switch start: sessions stay on screen, but the list is marked reloading
			// so redirect/new-session logic waits for the new worktree's data.
			mockSessions = [mockSessionItem("new")];
			act(() => {
				worktreeActions.setCurrent("feature");
			});

			expect(useSessionStore.getState().sessions[0].id).toBe("old");
			expect(useSessionStore.getState().isReloading).toBe(true);
			expect(useSessionStore.getState().isSuccess).toBe(false);

			// Switch end: the new worktree's list swaps in.
			await act(async () => {
				worktreeActions.notifyWorktreeSwitchEnd();
			});

			await waitFor(() => {
				expect(useSessionStore.getState().sessions[0].id).toBe("new");
			});
			expect(useSessionStore.getState().isReloading).toBe(false);
			expect(useSessionStore.getState().isSuccess).toBe(true);
		});
	});

	describe("paging", () => {
		it("appends the next page and keeps the cursor moving", async () => {
			mockSessions = [mockSessionItem("1")];
			mockNextCursor = "cursor-1";
			mockPage.mockResolvedValueOnce({
				sessions: [mockSessionItem("2")],
				next_cursor: "cursor-2",
				has_more: true,
			});

			const { result } = renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});

			await act(async () => {
				await result.current.loadMore();
			});

			expect(mockPage).toHaveBeenCalledWith("watch-1", "cursor-1");
			const state = useSessionStore.getState();
			expect(state.sessions.map((s) => s.id)).toEqual(["1", "2"]);
			expect(state.nextCursor).toBe("cursor-2");
		});

		it("does not ask again once the list has been read to its end", async () => {
			mockSessions = [mockSessionItem("1")];
			mockNextCursor = null;

			const { result } = renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});

			await act(async () => {
				await result.current.loadMore();
			});

			expect(mockPage).not.toHaveBeenCalled();
		});

		// Two subscribes can be in flight — a refresh racing a filter change —
		// and they can resolve in either order. The id the pages go to has to be
		// the one the last call asked for, not the one that answered last:
		// `useSubscription` already throws away the stale subscription, so a page
		// bound to it is a request against an id the server has just dropped.
		it("pages against the subscription asked for last, not the one that answered last", async () => {
			mockSessions = [mockSessionItem("1")];
			mockNextCursor = "cursor-1";

			let releaseFirst = () => {};
			const firstAnswered = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			const answer = (id: string) => ({
				id,
				initial: {
					sessions: mockSessions,
					next_cursor: mockNextCursor ?? undefined,
					has_more: mockNextCursor !== null,
					has_unread: mockHasUnread,
				},
			});
			mockSubscribe
				.mockImplementationOnce(async (callback) => {
					notificationCallback = callback;
					await firstAnswered;
					return answer("watch-1");
				})
				.mockImplementationOnce(async (callback) => {
					notificationCallback = callback;
					return answer("watch-2");
				});

			const { result } = renderHook(() => useSessionSubscription(true, false));

			// The second subscribe starts while the first is still in flight, and
			// answers first.
			await act(async () => {
				await result.current.refresh();
			});
			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});
			await act(async () => {
				releaseFirst();
				await firstAnswered;
			});

			await act(async () => {
				await result.current.loadMore();
			});

			expect(mockPage).toHaveBeenCalledWith("watch-2", "cursor-1");
		});

		// Silence would read as "that is the whole list", which is the one thing
		// the user must not conclude from a failure.
		it("reports a failed page and stops fetching by itself", async () => {
			mockSessions = [mockSessionItem("1")];
			mockNextCursor = "cursor-1";
			mockPage.mockRejectedValueOnce(new Error("boom"));

			const { result } = renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});

			await act(async () => {
				await result.current.loadMore();
			});

			const state = useSessionStore.getState();
			expect(state.pageError).toContain("boom");
			expect(state.autoLoad).toBe(false);
			expect(state.isLoadingMore).toBe(false);
		});

		// A resync hands back as much of the list as this client had, so it
		// replaces the list rather than extending it.
		it("replaces the list on a sync, cursor and all", async () => {
			mockSessions = [mockSessionItem("1")];
			mockNextCursor = "cursor-1";

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions).toHaveLength(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "sync",
					sessions: [mockSessionItem("2"), mockSessionItem("3")],
					next_cursor: "cursor-9",
					has_more: true,
					has_unread: true,
				});
			});

			const state = useSessionStore.getState();
			expect(state.sessions.map((s) => s.id)).toEqual(["2", "3"]);
			expect(state.nextCursor).toBe("cursor-9");
			expect(state.hasUnread).toBe(true);
		});

		// The subscription a page names can be gone — the server dropped it, or
		// the cursor is not one it handed out. Retry cannot fix either, so the
		// list is fetched afresh instead of offering a button that cannot work.
		it("resubscribes when the page is refused as invalid params", async () => {
			mockSessions = [mockSessionItem("1")];
			mockNextCursor = "cursor-1";
			mockPage.mockRejectedValueOnce(
				new JSONRPCErrorException(
					"no such subscription",
					JSONRPCErrorCode.InvalidParams,
				),
			);

			const { result } = renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});

			await act(async () => {
				await result.current.loadMore();
			});

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(2);
			});
			const state = useSessionStore.getState();
			expect(state.pageError).toBeNull();
			expect(state.isLoadingMore).toBe(false);
		});

		// The badge is an "is there any" over the whole list; a page cannot
		// answer it, so the server does (docs/list-paging-ui.md §2.1).
		it("takes the unread flag from the server, not from the rows it holds", async () => {
			mockSessions = [mockSessionItem("1")];
			mockHasUnread = true;

			renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().hasUnread).toBe(true);
			});
			expect(useSessionStore.getState().sessions[0].unread).toBe(false);

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSessionItem("1"),
					has_unread: false,
				});
			});

			expect(useSessionStore.getState().hasUnread).toBe(false);
		});
	});

	// The filter lives on the subscription, so the only way to change it is to
	// open a new one. Filtering what came back instead is what this replaced, and
	// that needed the whole work list to do it
	// (docs/code/subscription-system.md#which-sessions-belong-to-work).
	describe("the task-session filter", () => {
		it("asks the server for it, rather than narrowing the answer", async () => {
			mockSessions = [mockSessionItem("1")];

			renderHook(() => useSessionSubscription(true, true));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledWith(expect.any(Function), true);
			});
		});

		it("resubscribes when it is flipped, keeping the list on screen", async () => {
			mockSessions = [mockSessionItem("1")];

			const { rerender } = renderHook(
				({ exclude }: { exclude: boolean }) =>
					useSessionSubscription(true, exclude),
				{ initialProps: { exclude: false } },
			);

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});
			expect(mockSubscribe).toHaveBeenLastCalledWith(
				expect.any(Function),
				false,
			);

			mockSessions = [mockSessionItem("2")];
			rerender({ exclude: true });

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenLastCalledWith(
					expect.any(Function),
					true,
				);
			});
			await waitFor(() => {
				expect(useSessionStore.getState().sessions[0].id).toBe("2");
			});
			// Never blanked on the way: a flipped filter is not a reason to empty
			// the sidebar and lose where the user was in it.
			expect(useSessionStore.getState().isLoading).toBe(false);
			expect(useSessionStore.getState().isSuccess).toBe(true);
		});
	});

	describe("refresh", () => {
		it("re-subscribes and gets fresh data", async () => {
			mockSessions = [mockSessionItem("1")];

			const { result } = renderHook(() => useSessionSubscription(true, false));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			mockSessions = [mockSessionItem("2"), mockSessionItem("1")];

			await act(async () => {
				await result.current.refresh();
			});

			expect(mockUnsubscribe).toHaveBeenCalledWith("watch-1");
			expect(useSessionStore.getState().sessions[0].id).toBe("2");
		});
	});
});
