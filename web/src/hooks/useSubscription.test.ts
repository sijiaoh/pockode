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

describe("useSubscription", () => {
	const mockSubscribe = vi.fn();
	const mockUnsubscribe = vi.fn();
	const mockOnChanged = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockStatus = "connected";
		mockSubscribe.mockResolvedValue("sub-123");
		mockUnsubscribe.mockResolvedValue(undefined);
	});

	describe("subscription lifecycle", () => {
		it("subscribes when connected and enabled", async () => {
			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged),
			);

			await waitFor(() => {
				expect(mockSubscribe).toHaveBeenCalledTimes(1);
			});
		});

		it("does not subscribe when disabled", async () => {
			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged, {
					enabled: false,
				}),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("does not subscribe when disconnected", async () => {
			mockStatus = "disconnected";

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(mockSubscribe).not.toHaveBeenCalled();
		});

		it("unsubscribes on unmount", async () => {
			const { unmount } = renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged),
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
					useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged, {
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
			let resolveSubscribe: (id: string) => void = () => {};
			mockSubscribe.mockReturnValue(
				new Promise((resolve) => {
					resolveSubscribe = resolve;
				}),
			);

			const { unmount } = renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged),
			);

			expect(mockSubscribe).toHaveBeenCalled();
			expect(mockUnsubscribe).not.toHaveBeenCalled();

			unmount();

			await act(async () => {
				resolveSubscribe("sub-456");
			});

			expect(mockUnsubscribe).toHaveBeenCalledWith("sub-456");
		});
	});

	describe("callback invocation", () => {
		it("invokes onChanged when callback is called", async () => {
			let capturedCallback: (() => void) | null = null;
			mockSubscribe.mockImplementation((callback) => {
				capturedCallback = callback;
				return Promise.resolve("sub-789");
			});

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged),
			);

			await waitFor(() => {
				expect(capturedCallback).not.toBeNull();
			});

			act(() => {
				capturedCallback?.();
			});

			expect(mockOnChanged).toHaveBeenCalledTimes(1);
		});

		it("uses latest onChanged callback via ref", async () => {
			let capturedCallback: (() => void) | null = null;
			mockSubscribe.mockImplementation((callback) => {
				capturedCallback = callback;
				return Promise.resolve("sub-999");
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

	describe("error handling", () => {
		it("logs error when subscribe fails", async () => {
			const consoleSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			mockSubscribe.mockRejectedValue(new Error("Subscribe failed"));

			renderHook(() =>
				useSubscription(mockSubscribe, mockUnsubscribe, mockOnChanged),
			);

			await waitFor(() => {
				expect(consoleSpy).toHaveBeenCalledWith(
					"Subscription failed:",
					expect.any(Error),
				);
			});

			consoleSpy.mockRestore();
		});
	});
});
