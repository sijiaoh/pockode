import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	Work,
	WorkDetailChangedNotification,
	WorkDetailSubscribeResult,
	WorkUsage,
} from "../types/work";
import { useWorkDetailSubscription } from "./useWorkDetailSubscription";

let notificationCallback: ((p: WorkDetailChangedNotification) => void) | null =
	null;
let mockDetails: Record<string, WorkDetailSubscribeResult> = {};

const mockSubscribe = vi.fn(
	async (
		workId: string,
		callback: (p: WorkDetailChangedNotification) => void,
	) => {
		notificationCallback = callback;
		const detail = mockDetails[workId];
		if (!detail) throw new Error("work not found");
		return { id: `watch-${workId}`, initial: detail };
	},
);
const mockUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => {
		const state = {
			status: "connected",
			actions: {
				workDetailSubscribe: mockSubscribe,
				workDetailUnsubscribe: mockUnsubscribe,
			},
		};
		return selector(state);
	}),
}));

const work = (id: string): Work => ({
	id,
	type: "story",
	title: id,
	status: "active",
	activity: "idle",
	created_at: "2026-03-04T00:00:00Z",
	updated_at: "2026-03-04T00:00:00Z",
});

const usageOf = (total: number, descendants = 2): WorkUsage => ({
	total: {
		input_tokens: total,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
	},
	descendant_count: descendants,
});

describe("useWorkDetailSubscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		notificationCallback = null;
		mockDetails = {
			"work-1": {
				work: work("work-1"),
				comments: [],
				usage: usageOf(1_000),
				activity: "idle",
			},
			"work-2": {
				work: work("work-2"),
				comments: [],
				usage: usageOf(50),
				activity: "idle",
			},
		};
	});

	it("holds the usage the subscription opens with", async () => {
		const { result } = renderHook(() => useWorkDetailSubscription("work-1"));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.usage).toEqual(usageOf(1_000));
	});

	// The work item itself does not change when a session beneath it spends
	// tokens, so this notification is the only thing that keeps the figures
	// current while the agents run.
	it("takes the new usage from a change notification", async () => {
		const { result } = renderHook(() => useWorkDetailSubscription("work-1"));

		await waitFor(() => expect(result.current.loading).toBe(false));

		act(() => {
			notificationCallback?.({
				id: "watch-work-1",
				work: work("work-1"),
				comments: [],
				usage: usageOf(1_500),
				activity: "idle",
			});
		});

		expect(result.current.usage).toEqual(usageOf(1_500));
	});

	// The switch is a render apart from the new item's snapshot; what is held in
	// between belongs to the item just left.
	it("drops the previous item's usage the moment the work changes", async () => {
		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useWorkDetailSubscription(id),
			{ initialProps: { id: "work-1" } },
		);
		await waitFor(() => expect(result.current.usage).toEqual(usageOf(1_000)));

		rerender({ id: "work-2" });
		expect(result.current.usage).toBeNull();

		await waitFor(() => expect(result.current.usage).toEqual(usageOf(50)));
	});
});
