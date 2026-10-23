import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../lib/activity";
import { useScheduleStore } from "../lib/scheduleStore";
import { makeSchedule } from "../test/scheduleFixtures";
import type { ScheduleListChangedNotification } from "../types/schedule";
import type { WorkListItem } from "../types/work";
import { useScheduleSubscription } from "./useScheduleSubscription";

const scheduleListSubscribe = vi.fn();
const scheduleListUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({
			status: "connected",
			actions: { scheduleListSubscribe, scheduleListUnsubscribe },
		}),
	),
}));

vi.mock("../lib/worktreeStore", () => ({
	worktreeActions: {
		onWorktreeSwitchStart: vi.fn(() => () => {}),
		onWorktreeSwitchEnd: vi.fn(() => () => {}),
	},
}));

const TOKYO = { name: "JST", offset_seconds: 9 * 3600 };
const schedule = makeSchedule({ id: "s1" });

const run = (activity: Activity): WorkListItem => ({
	id: "run-1",
	type: "job",
	title: "Nightly audit",
	status: "active",
	activity,
	updated_at: "2026-10-23T03:00:00Z",
});

function notify(params: ScheduleListChangedNotification) {
	const callback = scheduleListSubscribe.mock.calls[0][0];
	act(() => callback(params));
}

async function subscribed() {
	renderHook(() => useScheduleSubscription(true));
	await waitFor(() =>
		expect(useScheduleStore.getState().isLoading).toBe(false),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	scheduleListUnsubscribe.mockResolvedValue(undefined);
	useScheduleStore.getState().reset();
	scheduleListSubscribe.mockResolvedValue({
		id: "sub-1",
		initial: { items: [schedule], server_zone: TOKYO },
	});
});

describe("useScheduleSubscription", () => {
	it("takes the schedules and the server's zone from the snapshot", async () => {
		await subscribed();

		expect(useScheduleStore.getState().schedules).toEqual([schedule]);
		expect(useScheduleStore.getState().serverZone).toEqual(TOKYO);
	});

	// The create reply lands first when the sheet adds it, and the list's own
	// notification after; the second must not make a second row.
	it("treats a create it already holds as an update", async () => {
		await subscribed();
		const created = makeSchedule({ id: "s2", title: "New" });
		useScheduleStore.getState().addCreatedSchedule(created);

		const renamed = { ...created, title: "Renamed" };
		notify({ id: "sub-1", operation: "create", schedule: renamed });

		expect(useScheduleStore.getState().schedules).toEqual([schedule, renamed]);
	});

	it("follows the latest run as the update that carries it, and drops a deleted schedule", async () => {
		await subscribed();

		notify({
			id: "sub-1",
			operation: "update",
			schedule: { ...schedule, last_run: run("running") },
		});
		expect(useScheduleStore.getState().schedules[0].last_run?.activity).toBe(
			"running",
		);

		notify({ id: "sub-1", operation: "delete", scheduleId: "s1" });
		expect(useScheduleStore.getState().schedules).toEqual([]);
	});

	it("replaces everything, zone included, on a sync", async () => {
		await subscribed();
		const other = makeSchedule({ id: "s9" });
		const utc = { name: "UTC", offset_seconds: 0 };

		notify({
			id: "sub-1",
			operation: "sync",
			schedules: [other],
			server_zone: utc,
		});

		expect(useScheduleStore.getState().schedules).toEqual([other]);
		expect(useScheduleStore.getState().serverZone).toEqual(utc);
	});

	// The run is drawn by the work components, which index their tables by
	// activity: one this build does not know must not blank the row.
	it("folds a latest run's unknown activity to one this build draws", async () => {
		await subscribed();

		notify({
			id: "sub-1",
			operation: "update",
			schedule: { ...schedule, last_run: run("from_the_future" as Activity) },
		});

		expect(useScheduleStore.getState().schedules[0].last_run?.activity).toBe(
			"idle",
		);
	});
});
