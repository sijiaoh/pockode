import type { WorkListItem } from "./work";

/** The intervals an hourly period takes: only divisors of 24. */
export type HourlyEvery = 1 | 2 | 3 | 4 | 6 | 8 | 12;

/**
 * When a schedule fires, as the server stores it: one of a closed set of
 * kinds, every time a wall-clock reading in the schedule's `time_zone`
 * (docs/projects/api.md#schedule-periods). Fields that do not belong to the
 * kind are refused, so one period has one spelling.
 */
export type Period =
	/** `at` is `YYYY-MM-DDTHH:MM`, no seconds, no offset. */
	| { kind: "once"; at: string }
	/** The server's defaults when absent: `every` 1, `minute` 0. */
	| { kind: "hourly"; every?: HourlyEvery; minute?: number }
	/** `time` is `HH:MM`, as on every kind below. */
	| { kind: "daily"; time: string }
	/** 0 is Sunday, 6 Saturday; ascending, fewer than seven. */
	| { kind: "weekly"; weekdays: number[]; time: string }
	/** 1–31; a month without `day` runs on its last, so 31 is "the last day". */
	| { kind: "monthly"; day: number; time: string };

/** A run the scheduler could not make or start, as the schedule records it. */
export interface ScheduleRunFailure {
	at: string;
	/** Set when the run was made but could not be started; it is left `open`. */
	work_id?: string;
	error: string;
}

/**
 * A schedule as the server stores it: the settings a person edits, and the run
 * bookkeeping the scheduler writes. Nothing here is derived — what the latest
 * run is doing rides beside it on a list item (`ScheduleListItem`).
 */
export interface Schedule {
	id: string;
	title: string;
	prompt: string;
	agent_role_id: string;
	period: Period;
	/** IANA name, e.g. `Asia/Tokyo` (docs/schedule-ui.md §6.5). */
	time_zone: string;
	enabled: boolean;
	/** Worktree each run is made in (empty/undefined = main). */
	worktree?: string;
	/**
	 * Absent while disabled, and on a one-time schedule once its time has been
	 * handled — which is what makes it done (`isDone`).
	 */
	next_run_at?: string;
	last_run_at?: string;
	last_run_work_id?: string;
	last_skipped_at?: string;
	/** Cleared by the next run that starts. */
	last_failure?: ScheduleRunFailure;
	created_at: string;
	updated_at: string;
}

/**
 * One row of `schedule.list`: the stored schedule, and beside it the row of
 * its latest run (`last_run_work_id`) as it is now — absent when there is none
 * or that work has been deleted. It is here because nothing else a client holds
 * carries a job's row: the work list leaves jobs out.
 */
export interface ScheduleListItem extends Schedule {
	last_run?: WorkListItem;
}

export interface ScheduleCreateParams {
	title: string;
	prompt: string;
	agent_role_id: string;
	period: Period;
	/** The device's zone: a schedule is made where its user is. */
	time_zone: string;
	/** Omitted makes an enabled schedule. */
	enabled?: boolean;
	/** Omitted or empty is main. */
	worktree?: string;
}

/** Pointer semantics: an omitted field is left alone. */
export interface ScheduleUpdateParams {
	id: string;
	title?: string;
	prompt?: string;
	agent_role_id?: string;
	/** Given whole, or left out to keep the stored one. */
	period?: Period;
	time_zone?: string;
	enabled?: boolean;
	/** Empty string is main. */
	worktree?: string;
}

/** One run of a schedule: a work row, plus when it was made — the run list's order. */
export interface ScheduleRunItem extends WorkListItem {
	created_at: string;
}

/** A page of a schedule's runs, newest made first. */
export interface ScheduleRunPage {
	items: ScheduleRunItem[];
	/** Opaque — handed back to the server unread. */
	next_cursor?: string;
	has_more?: boolean;
}

export interface ScheduleListSubscribeResult {
	items: ScheduleListItem[];
}

export type ScheduleListChangedNotification =
	| { id: string; operation: "create" | "update"; schedule: ScheduleListItem }
	| { id: string; operation: "delete"; scheduleId: string }
	| { id: string; operation: "sync"; schedules: ScheduleListItem[] };

/**
 * One schedule and the newest page of its runs. Every notification is the whole
 * of this again; older pages are read with `schedule.detail.runs`.
 */
export interface ScheduleDetailSubscribeResult {
	schedule: Schedule;
	runs: ScheduleRunPage;
}

export interface ScheduleDetailChangedNotification
	extends ScheduleDetailSubscribeResult {
	id: string;
}
