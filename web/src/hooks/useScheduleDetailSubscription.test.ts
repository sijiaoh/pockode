import { act, renderHook, waitFor } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRun, makeSchedule } from "../test/scheduleFixtures";
import type {
	ScheduleDetailChangedNotification,
	ScheduleRunPage,
} from "../types/schedule";
import { useScheduleDetailSubscription } from "./useScheduleDetailSubscription";

const scheduleDetailSubscribe = vi.fn();
const scheduleDetailUnsubscribe = vi.fn();
const scheduleDetailRuns = vi.fn();

// The real module underneath, so `isInvalidParamsRejection` — which the hook
// reads a recovery decision out of — is the one that ships.
vi.mock("../lib/wsStore", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/wsStore")>()),
	useWSStore: vi.fn((selector) =>
		selector({
			status: "connected",
			actions: {
				scheduleDetailSubscribe,
				scheduleDetailUnsubscribe,
				scheduleDetailRuns,
			},
		}),
	),
}));

const schedule = makeSchedule({ id: "s1" });
const runOn = (day: number) =>
	makeRun({ id: `run-${day}`, created_at: `2026-10-0${day}T03:00:00Z` });

const firstPage: ScheduleRunPage = {
	items: [runOn(4), runOn(3)],
	next_cursor: "c3",
	has_more: true,
};

function notify(params: Omit<ScheduleDetailChangedNotification, "id">) {
	const callback = scheduleDetailSubscribe.mock.calls.at(-1)?.[1];
	act(() => callback({ id: "sub-1", ...params }));
}

async function renderDetail() {
	const view = renderHook(() => useScheduleDetailSubscription("s1"));
	await waitFor(() => expect(view.result.current.loading).toBe(false));
	return view;
}

beforeEach(() => {
	vi.clearAllMocks();
	scheduleDetailUnsubscribe.mockResolvedValue(undefined);
	scheduleDetailSubscribe.mockResolvedValue({
		id: "sub-1",
		initial: { schedule, runs: firstPage },
	});
});

describe("useScheduleDetailSubscription", () => {
	it("reads older runs against its own subscription, and keeps them through the next notification", async () => {
		scheduleDetailRuns.mockResolvedValue({ items: [runOn(2)] });
		const { result } = await renderDetail();

		await act(() => result.current.loadMore());

		expect(scheduleDetailRuns).toHaveBeenCalledWith("sub-1", "c3");
		expect(result.current.hasMoreRuns).toBe(false);

		notify({
			schedule,
			runs: { items: [runOn(5), runOn(4)], next_cursor: "c4", has_more: true },
		});

		expect(result.current.runs.map((r) => r.id)).toEqual([
			"run-5",
			"run-4",
			"run-3",
			"run-2",
		]);
		expect(result.current.hasMoreRuns).toBe(false);
	});

	// The subscription the page belonged to is gone: asking again cannot work,
	// so the hook subscribes afresh rather than offering a Retry.
	it("subscribes afresh when its page is refused as invalid", async () => {
		scheduleDetailRuns.mockRejectedValue(
			new JSONRPCErrorException(
				"no such subscription",
				JSONRPCErrorCode.InvalidParams,
			),
		);
		const { result } = await renderDetail();

		await act(() => result.current.loadMore());

		await waitFor(() =>
			expect(scheduleDetailSubscribe).toHaveBeenCalledTimes(2),
		);
		expect(result.current.loadMoreError).toBeNull();
	});

	it("says a page failed rather than ending the list there", async () => {
		scheduleDetailRuns.mockRejectedValue(new Error("connection lost"));
		const { result } = await renderDetail();

		await act(() => result.current.loadMore());

		expect(result.current.loadMoreError).toBe(
			"Failed to load earlier runs: connection lost",
		);
		expect(result.current.hasMoreRuns).toBe(true);
	});
});
