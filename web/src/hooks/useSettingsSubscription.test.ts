import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../lib/settingsStore";
import { useSettingsSubscription } from "./useSettingsSubscription";

const settingsSubscribe = vi.fn();
const settingsUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({
			status: "connected",
			actions: { settingsSubscribe, settingsUnsubscribe },
		}),
	),
}));

vi.mock("../lib/worktreeStore", () => ({
	worktreeActions: {
		onWorktreeSwitchStart: vi.fn(() => () => {}),
		onWorktreeSwitchEnd: vi.fn(() => () => {}),
	},
}));

beforeEach(() => {
	vi.clearAllMocks();
	settingsUnsubscribe.mockResolvedValue(undefined);
	useSettingsStore.setState({ settings: null, error: null, refresh: null });
});

describe("useSettingsSubscription", () => {
	// A subscribe that fails leaves the socket open, so no banner appears and
	// nothing resubscribes on its own. Without a recorded reason the controls
	// that wait on the snapshot cannot tell that state from one still in flight,
	// and would wait on it forever.
	it("records why the snapshot is not coming, and hands back the way to ask again", async () => {
		settingsSubscribe.mockRejectedValueOnce(new Error("subscribe failed"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		renderHook(() => useSettingsSubscription(true));

		await waitFor(() =>
			expect(useSettingsStore.getState().error).toBe("subscribe failed"),
		);

		settingsSubscribe.mockResolvedValueOnce({
			id: "sub-1",
			initial: { default_mode: "yolo" },
		});
		const refresh = useSettingsStore.getState().refresh;
		await act(async () => refresh?.());

		expect(useSettingsStore.getState().settings).toEqual({
			default_mode: "yolo",
		});
		expect(useSettingsStore.getState().error).toBeNull();
	});

	// Otherwise a retry that fails the same way changes nothing on screen, and
	// reads as a button that does not work.
	it("goes back to waiting while the retry is in flight", async () => {
		settingsSubscribe.mockRejectedValueOnce(new Error("subscribe failed"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		renderHook(() => useSettingsSubscription(true));

		await waitFor(() =>
			expect(useSettingsStore.getState().error).toBe("subscribe failed"),
		);

		// Never settles: the assertion is about the state during the retry.
		settingsSubscribe.mockImplementationOnce(() => new Promise(() => {}));
		act(() => useSettingsStore.getState().refresh?.());

		expect(useSettingsStore.getState().error).toBeNull();
	});
});
