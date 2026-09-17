import { act, renderHook, waitFor } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	selectSessionDetail,
	selectSessionDetailStatus,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import { resetWorktreeStore, worktreeActions } from "../lib/worktreeStore";
import { makeSessionDetail } from "../test/sessionFixtures";
import type {
	SessionDetail,
	SessionDetailChangedNotification,
} from "../types/message";
import { useSessionDetailSubscription } from "./useSessionDetailSubscription";

let notificationCallback:
	| ((p: SessionDetailChangedNotification) => void)
	| null = null;
let mockStatus = "connected";
// Keyed by session id so a re-subscribe after a session switch answers with the
// session actually asked for, the way the server does.
let mockDetails: Record<string, SessionDetail> = {};

const mockSubscribe = vi.fn(
	async (
		sessionId: string,
		callback: (p: SessionDetailChangedNotification) => void,
	) => {
		notificationCallback = callback;
		const session = mockDetails[sessionId];
		// Refused the way the server refuses it — a written reply carrying
		// "invalid params" — because that code is the whole of what tells this
		// hook the refusal is about the session and not about the connection.
		if (!session) {
			throw new JSONRPCErrorException(
				"session not found",
				JSONRPCErrorCode.InvalidParams,
			);
		}
		return { id: `watch-${sessionId}`, initial: { session } };
	},
);
const mockUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/wsStore")>()),
	useWSStore: vi.fn((selector) => {
		const state = {
			status: mockStatus,
			actions: {
				sessionDetailSubscribe: mockSubscribe,
				sessionDetailUnsubscribe: mockUnsubscribe,
			},
		};
		return selector(state);
	}),
}));

const detailOf = (sessionId: string) =>
	selectSessionDetail(sessionId)(useSessionDetailStore.getState());

const statusOf = (sessionId: string) =>
	selectSessionDetailStatus(sessionId)(useSessionDetailStore.getState());

describe("useSessionDetailSubscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		notificationCallback = null;
		mockStatus = "connected";
		mockDetails = {
			s1: makeSessionDetail({ id: "s1" }),
			s2: makeSessionDetail({ id: "s2" }),
		};
		resetWorktreeStore();
		useSessionDetailStore.getState().clear();
	});

	it("holds the snapshot the subscription opens with", async () => {
		mockDetails.s1 = makeSessionDetail({
			id: "s1",
			model: "opus",
			effort: "high",
		});

		renderHook(() => useSessionDetailSubscription("s1"));

		await waitFor(() => {
			expect(detailOf("s1")?.model).toBe("opus");
		});
		expect(detailOf("s1")?.effort).toBe("high");
	});

	it("does not subscribe until the session is known to the worktree", async () => {
		renderHook(() => useSessionDetailSubscription("s1", false));

		await new Promise((r) => setTimeout(r, 50));

		expect(mockSubscribe).not.toHaveBeenCalled();
	});

	it("applies a change made elsewhere", async () => {
		renderHook(() => useSessionDetailSubscription("s1"));

		await waitFor(() => expect(detailOf("s1")).not.toBeNull());

		act(() => {
			notificationCallback?.({
				id: "watch-s1",
				session: makeSessionDetail({ id: "s1", mode: "yolo", activated: true }),
			});
		});

		expect(detailOf("s1")?.mode).toBe("yolo");
		expect(detailOf("s1")?.activated).toBe(true);
	});

	// A deleted session has no metadata left to describe. Keeping the last
	// snapshot would leave its settings on screen as if it were still there.
	it("drops the detail when the session is deleted", async () => {
		renderHook(() => useSessionDetailSubscription("s1"));

		await waitFor(() => expect(detailOf("s1")).not.toBeNull());

		act(() => {
			notificationCallback?.({ id: "watch-s1", deleted: true });
		});

		expect(detailOf("s1")).toBeNull();
	});

	// The switch is a render apart from the new session's snapshot. What is held
	// in between belongs to the session just left, and must not be readable under
	// the id of the one just opened.
	it("never reports the previous session's detail under the new session id", async () => {
		mockDetails.s1 = makeSessionDetail({ id: "s1", model: "opus" });
		mockDetails.s2 = makeSessionDetail({ id: "s2", model: "sonnet" });

		const { rerender } = renderHook(
			({ id }: { id: string }) => useSessionDetailSubscription(id),
			{ initialProps: { id: "s1" } },
		);
		await waitFor(() => expect(detailOf("s1")?.model).toBe("opus"));

		rerender({ id: "s2" });
		expect(detailOf("s2")).toBeNull();

		await waitFor(() => expect(detailOf("s2")?.model).toBe("sonnet"));
		expect(mockUnsubscribe).toHaveBeenCalledWith("watch-s1");
	});

	// The server tears this subscription down on a worktree switch, and the
	// session goes with it. The caller stops asking (`enabled` follows the session
	// list), which is what clears the detail — resubscribing here would only ask
	// the new worktree about a session id it has never heard of.
	it("does not re-ask the new worktree for the old session", async () => {
		const { rerender } = renderHook(
			({ enabled }: { enabled: boolean }) =>
				useSessionDetailSubscription("s1", enabled),
			{ initialProps: { enabled: true } },
		);
		await waitFor(() => expect(detailOf("s1")).not.toBeNull());

		await act(async () => {
			worktreeActions.setCurrent("feature");
			worktreeActions.notifyWorktreeSwitchEnd();
		});
		expect(mockSubscribe).toHaveBeenCalledTimes(1);

		rerender({ enabled: false });
		expect(detailOf("s1")).toBeNull();
	});

	// A subscribe fails when the session has gone between the route naming it and
	// this asking about it. Keeping the last snapshot would leave a deleted
	// session's settings on screen, live-looking and unchangeable.
	it("holds nothing when the subscribe is refused", async () => {
		useSessionDetailStore.getState().setDetail("s1", makeSessionDetail());
		delete mockDetails.s1;

		renderHook(() => useSessionDetailSubscription("s1"));

		await waitFor(() => expect(detailOf("s1")).toBeNull());
	});

	// Whether the open session exists is this subscription's answer to give — the
	// session list cannot, because the task-session filter makes a hidden session
	// look exactly like a deleted one
	// (docs/code/subscription-system.md#which-sessions-belong-to-work). The app
	// shell redirects off a `missing` session, so the three values have to stay
	// apart.
	describe("whether the session exists", () => {
		it("is unknown until the snapshot lands, then settled", async () => {
			expect(statusOf("s1")).toBe("loading");

			renderHook(() => useSessionDetailSubscription("s1"));

			await waitFor(() => expect(statusOf("s1")).toBe("ready"));
		});

		it("is missing once the subscribe is refused", async () => {
			delete mockDetails.s1;

			renderHook(() => useSessionDetailSubscription("s1"));

			await waitFor(() => expect(statusOf("s1")).toBe("missing"));
		});

		it("is missing once the session is deleted", async () => {
			renderHook(() => useSessionDetailSubscription("s1"));
			await waitFor(() => expect(statusOf("s1")).toBe("ready"));

			act(() => {
				notificationCallback?.({ id: "watch-s1", deleted: true });
			});

			expect(statusOf("s1")).toBe("missing");
		});

		// A dropped connection is not news about the session, and reading it as
		// one would navigate the user off the conversation they were in every
		// time the socket blinked.
		it("goes back to unknown, not missing, when the subscription ends", async () => {
			const { rerender } = renderHook(
				({ enabled }: { enabled: boolean }) =>
					useSessionDetailSubscription("s1", enabled),
				{ initialProps: { enabled: true } },
			);
			await waitFor(() => expect(statusOf("s1")).toBe("ready"));

			rerender({ enabled: false });

			expect(statusOf("s1")).toBe("loading");
		});

		// The socket dying with the subscribe still in flight rejects it exactly
		// as a refusal does, minus the server's own error code. Reading that as
		// "gone" would take the user off the conversation they are in every time
		// the connection blinks — and for a session the sidebar filter hides,
		// which is every session a work item drives, the list cannot put it back.
		it("stays unknown when the subscribe fails with the connection", async () => {
			mockSubscribe.mockRejectedValueOnce(
				new JSONRPCErrorException("Connection lost", 0),
			);

			renderHook(() => useSessionDetailSubscription("s1"));

			await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());
			await new Promise((r) => setTimeout(r, 20));
			expect(statusOf("s1")).toBe("loading");
		});

		// A verdict about the session just left says nothing about the one just
		// opened, and the two are a render apart.
		it("says nothing about a session it has not been asked about", async () => {
			delete mockDetails.s1;

			const { rerender } = renderHook(
				({ id }: { id: string }) => useSessionDetailSubscription(id),
				{ initialProps: { id: "s1" } },
			);
			await waitFor(() => expect(statusOf("s1")).toBe("missing"));

			rerender({ id: "s2" });
			expect(statusOf("s2")).toBe("loading");

			await waitFor(() => expect(statusOf("s2")).toBe("ready"));
		});
	});

	it("unsubscribes on unmount", async () => {
		const { unmount } = renderHook(() => useSessionDetailSubscription("s1"));

		await waitFor(() => expect(mockSubscribe).toHaveBeenCalled());

		unmount();

		expect(mockUnsubscribe).toHaveBeenCalledWith("watch-s1");
	});
});
