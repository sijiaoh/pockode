import { act, renderHook, waitFor } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { canvasActions } from "../lib/canvasStore";
import { useWSStore } from "../lib/wsStore";
import type { CanvasHistoryEntry, CanvasSnapshot } from "../types/canvas";
import { useCanvasHistory } from "./useCanvasHistory";

const entry = (revision: number): CanvasHistoryEntry => ({
	revision,
	change_kind: "render",
	drawn_at: "2026-10-31T14:02:00Z",
	bytes: 10,
});

const snapshot = (revision: number): CanvasSnapshot => ({
	revision,
	html: `<p>${revision}</p>`,
	change: { kind: "render" },
	drawn_at: "2026-10-31T14:02:00Z",
});

/** A promise and the hands that settle it. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const actions = useWSStore.getState().actions;
let canvasHistory: MockInstance<typeof actions.canvasHistory>;
let canvasSnapshot: MockInstance<typeof actions.canvasSnapshot>;

beforeEach(() => {
	useWSStore.setState({ status: "connected" });
	canvasActions.receive("s1", { revision: 3 });
	canvasHistory = vi
		.spyOn(actions, "canvasHistory")
		.mockResolvedValue([entry(3), entry(2), entry(1)]);
	canvasSnapshot = vi
		.spyOn(actions, "canvasSnapshot")
		.mockImplementation(async (_, revision) => snapshot(revision));
});

afterEach(() => {
	vi.restoreAllMocks();
	canvasActions.forget("s1");
	useWSStore.setState({ status: "disconnected" });
});

describe("useCanvasHistory", () => {
	describe("the list", () => {
		it("is read when the view opens", async () => {
			const { result } = renderHook(() => useCanvasHistory("s1", null));
			await waitFor(() =>
				expect(result.current.entries?.map((e) => e.revision)).toEqual([
					3, 2, 1,
				]),
			);
			expect(canvasHistory).toHaveBeenCalledWith("s1");
		});

		// One in flight, at most one more: a burst costs two reads, and the
		// newer answer is the one kept.
		it("reads once more for a burst of pushes while a read is in flight", async () => {
			const first = deferred<CanvasHistoryEntry[]>();
			const second = deferred<CanvasHistoryEntry[]>();
			canvasHistory
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise);
			const { result } = renderHook(() => useCanvasHistory("s1", null));

			act(() => {
				canvasActions.receive("s1", { revision: 4 });
				canvasActions.receive("s1", { revision: 5 });
				canvasActions.receive("s1", { revision: 6 });
			});
			expect(canvasHistory).toHaveBeenCalledTimes(1);

			await act(async () => first.resolve([entry(3)]));
			expect(canvasHistory).toHaveBeenCalledTimes(2);
			await act(async () => second.resolve([entry(6), entry(5)]));
			expect(result.current.entries?.map((e) => e.revision)).toEqual([6, 5]);
			expect(canvasHistory).toHaveBeenCalledTimes(2);
		});

		it("is read again when the connection comes back", async () => {
			renderHook(() => useCanvasHistory("s1", null));
			await waitFor(() => expect(canvasHistory).toHaveBeenCalledTimes(1));

			act(() => useWSStore.setState({ status: "reconnecting" }));
			act(() => useWSStore.setState({ status: "connected" }));
			await waitFor(() => expect(canvasHistory).toHaveBeenCalledTimes(2));
		});

		// `pending` is pushed by nothing; a settling call is what may clear it.
		it("is read again on a settling canvas call while an entry is pending", async () => {
			canvasHistory.mockResolvedValue([
				{ ...entry(3), fork_blocked: "pending" },
				entry(2),
			]);
			const { result } = renderHook(() => useCanvasHistory("s1", null));
			await waitFor(() => expect(result.current.entries).not.toBeNull());

			canvasHistory.mockResolvedValue([entry(3), entry(2)]);
			act(() => canvasActions.callSettled());
			await waitFor(() =>
				expect(result.current.entries?.[0].fork_blocked).toBeUndefined(),
			);
			expect(canvasHistory).toHaveBeenCalledTimes(2);

			// Nothing pending any more: a call settling changes nothing listed.
			act(() => canvasActions.callSettled());
			expect(canvasHistory).toHaveBeenCalledTimes(2);
		});

		// The read in flight may have been answered from before the result.
		it("is read again on a settling canvas call while a read is in flight", async () => {
			const first = deferred<CanvasHistoryEntry[]>();
			canvasHistory.mockReturnValueOnce(first.promise);
			renderHook(() => useCanvasHistory("s1", null));

			act(() => canvasActions.callSettled());
			await act(async () => first.resolve([entry(3)]));
			expect(canvasHistory).toHaveBeenCalledTimes(2);
		});

		it("keeps what it had when a read fails, and says so", async () => {
			const { result } = renderHook(() => useCanvasHistory("s1", null));
			await waitFor(() => expect(result.current.entries).not.toBeNull());

			canvasHistory.mockRejectedValueOnce(new Error("Not connected"));
			act(() => canvasActions.receive("s1", { revision: 4 }));
			await waitFor(() =>
				expect(result.current.listError?.message).toBe("Not connected"),
			);
			expect(result.current.entries).toHaveLength(3);
		});
	});

	describe("snapshots", () => {
		it("are read for the open revision, and not again when stepped back to", async () => {
			const { result, rerender } = renderHook(
				({ revision }) => useCanvasHistory("s1", revision),
				{ initialProps: { revision: 2 as number | null } },
			);
			expect(result.current.snapshot).toEqual({ status: "loading" });
			await waitFor(() =>
				expect(result.current.snapshot).toEqual({
					status: "loaded",
					snapshot: snapshot(2),
				}),
			);

			rerender({ revision: 1 });
			await waitFor(() =>
				expect(result.current.snapshot?.status).toBe("loaded"),
			);
			rerender({ revision: 2 });
			expect(result.current.snapshot).toEqual({
				status: "loaded",
				snapshot: snapshot(2),
			});
			expect(canvasSnapshot.mock.calls.map(([, r]) => r)).toEqual([2, 1]);
		});

		it("are read one at a time, the page moved to once the last answers", async () => {
			const first = deferred<CanvasSnapshot>();
			canvasSnapshot.mockReturnValueOnce(first.promise);
			const { result, rerender } = renderHook(
				({ revision }) => useCanvasHistory("s1", revision),
				{ initialProps: { revision: 3 } },
			);
			rerender({ revision: 2 });
			rerender({ revision: 1 });
			expect(canvasSnapshot).toHaveBeenCalledTimes(1);

			await act(async () => first.resolve(snapshot(3)));
			await waitFor(() =>
				expect(result.current.snapshot).toEqual({
					status: "loaded",
					snapshot: snapshot(1),
				}),
			);
			expect(canvasSnapshot.mock.calls.map(([, r]) => r)).toEqual([3, 1]);
		});

		it("offers no retry for a revision the server refuses", async () => {
			canvasSnapshot.mockRejectedValueOnce(
				new JSONRPCErrorException(
					"the canvas has no such revision: revision 2 was lost from disk",
					JSONRPCErrorCode.InvalidParams,
				),
			);
			const { result } = renderHook(() => useCanvasHistory("s1", 2));
			await waitFor(() =>
				expect(result.current.snapshot).toMatchObject({
					status: "failed",
					retryable: false,
					error: {
						message:
							"the canvas has no such revision: revision 2 was lost from disk",
					},
				}),
			);
		});

		it("are read again once the connection is back, after failing offline", async () => {
			canvasSnapshot.mockRejectedValueOnce(new Error("Not connected"));
			const { result } = renderHook(() => useCanvasHistory("s1", 2));
			await waitFor(() =>
				expect(result.current.snapshot).toMatchObject({
					status: "failed",
					retryable: true,
				}),
			);

			act(() => useWSStore.setState({ status: "reconnecting" }));
			act(() => useWSStore.setState({ status: "connected" }));
			await waitFor(() =>
				expect(result.current.snapshot?.status).toBe("loaded"),
			);
		});

		it("are read again on Retry", async () => {
			canvasSnapshot.mockRejectedValueOnce(new Error("internal error"));
			const { result } = renderHook(() => useCanvasHistory("s1", 2));
			await waitFor(() =>
				expect(result.current.snapshot?.status).toBe("failed"),
			);

			act(() => result.current.retrySnapshot());
			await waitFor(() =>
				expect(result.current.snapshot?.status).toBe("loaded"),
			);
		});
	});
});
