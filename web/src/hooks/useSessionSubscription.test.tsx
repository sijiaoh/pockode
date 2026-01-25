import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../lib/sessionStore";
import { useUnreadStore } from "../lib/unreadStore";
import type {
	SessionListChangedNotification,
	SessionMeta,
} from "../types/message";
import { useSessionSubscription } from "./useSessionSubscription";

const mockSession = (id: string, title = "Test"): SessionMeta => ({
	id,
	title,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	mode: "default",
});

let notificationCallback: ((p: SessionListChangedNotification) => void) | null =
	null;
let mockSessions: SessionMeta[] = [];
let mockStatus = "connected";

const mockSubscribe = vi.fn(
	async (callback: (p: SessionListChangedNotification) => void) => {
		notificationCallback = callback;
		return { id: "watch-1", initial: mockSessions };
	},
);
const mockUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => {
		const state = {
			status: mockStatus,
			actions: {
				sessionListSubscribe: mockSubscribe,
				sessionListUnsubscribe: mockUnsubscribe,
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
		mockStatus = "connected";
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
		useUnreadStore.setState({
			unreadSessionIds: new Set(),
			viewingSessionId: null,
		});
	});

	describe("subscription lifecycle", () => {
		it("subscribes when enabled and connected", async () => {
			mockSessions = [mockSession("1")];

			renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});
			expect(useSessionStore.getState().sessions.length).toBe(1);
		});

		it("does not subscribe when disabled", async () => {
			renderHook(() => useSessionSubscription(false));

			await new Promise((r) => setTimeout(r, 50));

			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("does not subscribe when disconnected", async () => {
			mockStatus = "disconnected";

			renderHook(() => useSessionSubscription(true));

			await new Promise((r) => setTimeout(r, 50));

			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("unsubscribes on unmount", async () => {
			mockSessions = [mockSession("1")];

			const { unmount } = renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});

			unmount();

			expect(mockUnsubscribe).toHaveBeenCalledWith("watch-1");
		});
	});

	describe("notification handling", () => {
		it("handles create notification", async () => {
			mockSessions = [mockSession("1")];

			renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "create",
					session: mockSession("2"),
				});
			});

			expect(useSessionStore.getState().sessions.length).toBe(2);
			expect(useSessionStore.getState().sessions[0].id).toBe("2");
		});

		it("handles update notification", async () => {
			mockSessions = [mockSession("1", "Old")];

			renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions[0].title).toBe("Old");
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSession("1", "New"),
				});
			});

			expect(useSessionStore.getState().sessions[0].title).toBe("New");
		});

		it("marks session as unread on update when not viewing", async () => {
			mockSessions = [mockSession("1")];

			renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSession("1", "Updated"),
				});
			});

			expect(useUnreadStore.getState().unreadSessionIds.has("1")).toBe(true);
		});

		it("does not mark session as unread on update when viewing", async () => {
			mockSessions = [mockSession("1")];
			useUnreadStore.setState({ viewingSessionId: "1" });

			renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "update",
					session: mockSession("1", "Updated"),
				});
			});

			expect(useUnreadStore.getState().unreadSessionIds.has("1")).toBe(false);
		});

		it("does not mark session as unread on create", async () => {
			mockSessions = [];

			renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});

			act(() => {
				notificationCallback?.({
					id: "watch-1",
					operation: "create",
					session: mockSession("1"),
				});
			});

			expect(useUnreadStore.getState().unreadSessionIds.has("1")).toBe(false);
		});

		it("handles delete notification", async () => {
			mockSessions = [mockSession("1"), mockSession("2")];

			renderHook(() => useSessionSubscription(true));

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
	});

	describe("refresh", () => {
		it("re-subscribes and gets fresh data", async () => {
			mockSessions = [mockSession("1")];

			const { result } = renderHook(() => useSessionSubscription(true));

			await waitFor(() => {
				expect(useSessionStore.getState().sessions.length).toBe(1);
			});

			mockSessions = [mockSession("2"), mockSession("1")];

			await act(async () => {
				await result.current.refresh();
			});

			expect(mockUnsubscribe).toHaveBeenCalledWith("watch-1");
			expect(useSessionStore.getState().sessions[0].id).toBe("2");
		});
	});
});
