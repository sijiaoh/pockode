import type { ScheduleListItem, ScheduleRunItem } from "../types/schedule";

/**
 * A schedule as `schedule.list` reports it, enabled and never run. Tests
 * override only the fields their case is about.
 */
export function makeSchedule(
	overrides: Partial<ScheduleListItem> = {},
): ScheduleListItem {
	return {
		id: "sched-1",
		title: "Nightly audit",
		prompt: "Audit the dependencies.",
		agent_role_id: "role-job",
		cron: "0 3 * * *",
		enabled: true,
		next_run_at: "2026-10-24T03:00:00Z",
		created_at: "2026-10-01T00:00:00Z",
		updated_at: "2026-10-01T00:00:00Z",
		...overrides,
	};
}

/** One run of a schedule, as its run list reports it: a closed job. */
export function makeRun(
	overrides: Partial<ScheduleRunItem> = {},
): ScheduleRunItem {
	return {
		id: "run-1",
		type: "job",
		title: "Nightly audit",
		status: "closed",
		activity: "closed",
		created_at: "2026-10-23T03:00:00Z",
		updated_at: "2026-10-23T03:10:00Z",
		...overrides,
	};
}
