import { create } from "zustand";
import type { Schedule, ScheduleListItem, ServerZone } from "../types/schedule";
import { needsAttention } from "./activity";
import { normalizeWorkRow, useWorkNeedsAttention } from "./workStore";

interface ScheduleState {
	schedules: ScheduleListItem[];
	/**
	 * The zone every cron is evaluated in, as the subscription last reported it.
	 * Null until the first snapshot.
	 */
	serverZone: ServerZone | null;
	isLoading: boolean;
	error: string | null;
}

interface ScheduleActions {
	setSchedules: (schedules: ScheduleListItem[], serverZone: ServerZone) => void;
	updateSchedules: (
		updater: (old: ScheduleListItem[]) => ScheduleListItem[],
	) => void;
	/**
	 * Adds a schedule this client just created, from the create reply. The list
	 * notification can land after the reply, and the detail page opened on the
	 * new schedule reads a loaded store without its id as "deleted"
	 * (docs/schedule-ui.md §5). Never replaces: by the time the reply lands the
	 * subscription may already hold a newer record of it.
	 */
	addCreatedSchedule: (schedule: Schedule) => void;
	setError: (error: string) => void;
	reset: () => void;
}

type ScheduleStore = ScheduleState & ScheduleActions;

export const useScheduleStore = create<ScheduleStore>((set) => ({
	schedules: [],
	serverZone: null,
	isLoading: true,
	error: null,
	setSchedules: (schedules, serverZone) =>
		set({
			schedules: schedules.map(normalizeScheduleRow),
			serverZone,
			isLoading: false,
			error: null,
		}),
	updateSchedules: (updater) =>
		set((state) => ({
			schedules: updater(state.schedules).map(normalizeScheduleRow),
		})),
	addCreatedSchedule: (schedule) =>
		set((state) =>
			state.schedules.some((s) => s.id === schedule.id)
				? state
				: { schedules: [...state.schedules, schedule] },
		),
	setError: (error) => set({ isLoading: false, error }),
	reset: () =>
		set({ schedules: [], serverZone: null, isLoading: true, error: null }),
}));

/**
 * A schedule as it arrived, with its latest run's activity folded to a leaf
 * this build knows — the run is drawn by the work components, which index
 * their activity tables directly. Unchanged rows keep their identity.
 */
function normalizeScheduleRow(row: ScheduleListItem): ScheduleListItem {
	if (!row.last_run) return row;
	const lastRun = normalizeWorkRow(row.last_run);
	return lastRun === row.last_run ? row : { ...row, last_run: lastRun };
}

/**
 * Whether some schedule's latest run is waiting on the user — the Schedules
 * entry's dot. Only the latest run is read: at most one run of a schedule is
 * active, and it is that one (docs/schedule-ui.md §1). A failed firing does not
 * count; it needs a person whenever they get to it, which the row's edge says.
 */
export function useScheduleNeedsAttention(): boolean {
	return useScheduleStore((s) =>
		s.schedules.some(
			(schedule) =>
				schedule.last_run !== undefined &&
				needsAttention(
					schedule.last_run.activity,
					schedule.last_run.unanswered_questions,
				),
		),
	);
}

/**
 * The Project tab's one bit: stories or schedules. Jobs are kept out of the
 * work list, so the stories half alone cannot see a job asking a question —
 * and an unattended run that asks is exactly what the badge is there for.
 * Read by `useSidebarAttention`, which feeds the tab badge and the header
 * button together.
 */
export function useProjectNeedsAttention(): boolean {
	const stories = useWorkNeedsAttention();
	const schedules = useScheduleNeedsAttention();
	return stories || schedules;
}
