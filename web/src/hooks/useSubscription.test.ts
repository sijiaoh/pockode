import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSubscription } from "./useSubscription";

let mockStatus = "connected";

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => {
		const state = { status: mockStatus };
		return selector(state);
	}),
}));

const switchStartCallbacks: Array<() => void> = [];
const switchEndCallbacks: Array<() => void> = [];

vi.mock("../lib/worktreeStore", () => ({
	worktreeActions: {
		onWorktreeSwitchStart: vi.fn((callback: () => void) => {
			switchStartCallbacks.push(callback);
			return () => {
				const index = switchStartCallbacks.indexOf(callback);
				if (index !== -1) switchStartCallbacks.splice(index, 1);
			};
		}),
		onWorktreeSwitchEnd: vi.fn((callback: () => void) => {
			switchEndCallbacks.push(callback);
			return () => {
				const index = switchEndCallbacks.indexOf(callback);
				if (index !== -1) switchEndCallbacks.splice(index, 1);
			};
		}),
	},
}));

describe("useSubscription", () => {
	const mockSubscribe = vi.fn();
	const mockUnsubscribe = vi.fn();
	const mockOnNotification = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockStatus = "connected";
		switchStartCallbacks.length = 0;
		switchEndCallbacks.length = 0;
		mockSubscribe.mockResolvedValue({ id: "sub-123" });
		mockUnsubscribe.mockResolvedValue(undefined);
	});

	describe("subscription lifecycle", () => {
		it("subscribes when connected and enabled", async () => {
			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});
		});

		it("does not subscribe when disabled", async () => {
			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					enabled: false,
				}),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("does not subscribe when disconnected", async () => {
			mockStatus = "disconnected";

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("unsubscribes on unmount", async () => {
			const { unmount } = renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});

			unmount();

			expect(mockUnsubscribe).toHaveBeenCalledWith("sub-123");
		});

		it("unsubscribes when disabled after being enabled", async () => {
			const { rerender } = renderHook(
				({ enabled }) =>
					useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
						enabled,
					}),
				{ initialProps: { enabled: true } },
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});

			rerender({ enabled: false });

			expect(mockUnsubscribe).toHaveBeenCalledWith("sub-123");
		});
	});

	describe("race condition handling", () => {
		it("unsubscribes if unmounted before subscribe completes", async () => {
			let resolveSubscribe: (result: { id: string }) => void = () => {};
			mockSubscribe.mockReturnValue(
				new Promise((resolve) => {
					resolveSubscribe = resolve;
				}),
			);

			const { unmount } = renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			expect(mockSubscribe).toHaveBeenCalled();
			expect(mockUnsubscribe).not.toHaveBeenCalled();

			unmount();

			await act(async () => {
				resolveSubscribe({ id: "sub-456" });
			});

			expect(mockUnsubscribe).toHaveBeenCalledWith("sub-456");
		});
	});

	describe("callback invocation", () => {
		it("invokes onChanged when callback is called", async () => {
			let capturedCallback: (() => void) | null = null;
			mockSubscribe.mockImplementation((callback) => {
				capturedCallback = callback;
				return Promise.resolve({ id: "sub-789" });
			});

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await waitFor(() => {
				expect(capturedCallback).not.toBeNull();
			});

			act(() => {
				capturedCallback?.();
			});

			expect(mockOnNotification).toHaveBeenCalledTimes(1);
		});

		it("uses latest onChanged callback via ref", async () => {
			let capturedCallback: (() => void) | null = null;
			mockSubscribe.mockImplementation((callback) => {
				capturedCallback = callback;
				return Promise.resolve({ id: "sub-999" });
			});

			const onChanged1 = vi.fn();
			const onChanged2 = vi.fn();

			const { rerender } = renderHook(
				({ onChanged }) =>
					useSubscription(mockSubscribe, mockUnsubscribe, onChanged),
				{ initialProps: { onChanged: onChanged1 } },
			);

			await waitFor(() => {
				expect(capturedCallback).not.toBeNull();
			});

			rerender({ onChanged: onChanged2 });

			act(() => {
				capturedCallback?.();
			});

			expect(onChanged1).not.toHaveBeenCalled();
			expect(onChanged2).toHaveBeenCalledTimes(1);
		});
	});

	describe("initial data and callbacks", () => {
		it("calls onSubscribed with initial data", async () => {
			const onSubscribed = vi.fn();
			mockSubscribe.mockResolvedValue({
				id: "sub-init",
				initial: ["item1", "item2"],
			});

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					onSubscribed,
				}),
			);

			await waitFor(() => {
				expect(onSubscribed).toHaveBeenCalledWith(["item1", "item2"]);
			});
		});

		it("does not call onSubscribed when no initial data", async () => {
			const onSubscribed = vi.fn();
			mockSubscribe.mockResolvedValue({ id: "sub-no-init" });

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					onSubscribed,
				}),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalled();
			});
			await new Promise((r) => setTimeout(r, 50));
			expect(onSubscribed).not.toHaveBeenCalled();
		});

		it("calls onReset when disconnected", async () => {
			const onReset = vi.fn();
			mockStatus = "disconnected";

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					onReset,
				}),
			);

			await waitFor(() => {
				expect(onReset).toHaveBeenCalled();
			});
		});
	});

	describe("refresh", () => {
		it("resubscribes when refresh is called", async () => {
			mockSubscribe
				.mockResolvedValueOnce({ id: "sub-1" })
				.mockResolvedValueOnce({ id: "sub-2" });

			const { result } = renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});

			await act(async () => {
				await result.current.refresh();
			});

			expect(mockUnsubscribe).toHaveBeenCalledWith("sub-1");
			expect(mockSubscribe).toHaveBeenCalledTimes(2);
		});
	});

	describe("worktree switch handling", () => {
		it("unsubscribes on switchStart, resubscribes on switchEnd", async () => {
			mockSubscribe
				.mockResolvedValueOnce({ id: "sub-1" })
				.mockResolvedValueOnce({ id: "sub-2" });

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});

			expect(switchStartCallbacks.length).toBe(1);
			expect(switchEndCallbacks.length).toBe(1);

			await act(async () => {
				switchStartCallbacks[0]?.();
			});
			expect(mockUnsubscribe).toHaveBeenCalledWith("sub-1");

			await act(async () => {
				switchEndCallbacks[0]?.();
			});

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(2);
			});
		});

		it("does not register listeners when resubscribeOnWorktreeChange is false", async () => {
			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					resubscribeOnWorktreeChange: false,
				}),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});

			expect(switchStartCallbacks.length).toBe(0);
			expect(switchEndCallbacks.length).toBe(0);
		});

		it("calls onReset on switchStart, resubscribes on switchEnd", async () => {
			const onReset = vi.fn();
			const callOrder: string[] = [];

			onReset.mockImplementation(() => callOrder.push("reset"));
			mockSubscribe.mockImplementation(() => {
				callOrder.push("subscribe");
				return Promise.resolve({ id: `sub-${callOrder.length}` });
			});

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					onReset,
				}),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});

			await act(async () => {
				switchStartCallbacks[0]?.();
			});
			expect(callOrder).toEqual(["subscribe", "reset"]);

			await act(async () => {
				switchEndCallbacks[0]?.();
			});

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(2);
			});

			expect(callOrder).toEqual(["subscribe", "reset", "subscribe"]);
		});
	});

	describe("error handling", () => {
		it("logs error when subscribe fails", async () => {
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			mockSubscribe.mockRejectedValue(new Error("Subscribe failed"));

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification),
			);

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					"Subscription failed:",
					expect.any(Error),
				);
			});

			consoleSpy.mockRestore();
		});

		it("calls onReset when subscribe fails", async () => {
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const onReset = vi.fn();
			mockSubscribe.mockRejectedValue(new Error("Subscribe failed"));

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnNotification, {
					onReset,
				}),
			);

			await waitFor(() => {
				expect(onReset).toHaveBeenCalled();
			});

			consoleSpy.mockRestore();
		});
	});
});
