import { AlertCircle, Loader2, Plus } from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import { useScheduleEnabledToggle } from "../../hooks/useScheduleEnabledToggle";
import { ACTIVITY_VIEW } from "../../lib/activity";
import {
	deviceOffsetSeconds,
	periodZoneSuffix,
} from "../../lib/schedulePeriod";
import { compareNewestFirst } from "../../lib/scheduleRuns";
import { useScheduleStore } from "../../lib/scheduleStore";
import type { ScheduleListItem, ServerZone } from "../../types/schedule";
import {
	formatRelativeDate,
	formatRelativeFuture,
} from "../../utils/relativeTime";
import PageHeader from "../Layout/PageHeader";
import { ActivityIcon } from "../ui";
import BottomActionBar from "../ui/BottomActionBar";
import Switch from "../ui/Switch";
import CreateScheduleSheet from "./CreateScheduleSheet";
import PeriodWords from "./PeriodWords";
import { workEdgeClass } from "./WorkRow";

interface Props {
	onBack: () => void;
	onOpenScheduleDetail: (scheduleId: string) => void;
}

/**
 * Every schedule, newest made first and never re-sorted by state: a handful of
 * standing settings that a user finds by where they always are. The edge and
 * the third line are what say "look at this one" (docs/schedule-ui.md §3).
 */
export default function ScheduleListOverlay({
	onBack,
	onOpenScheduleDetail,
}: Props) {
	const schedules = useScheduleStore((s) => s.schedules);
	const serverZone = useScheduleStore((s) => s.serverZone);
	const isLoading = useScheduleStore((s) => s.isLoading);
	const error = useScheduleStore((s) => s.error);

	const sorted = useMemo(
		() => [...schedules].sort(compareNewestFirst),
		[schedules],
	);

	const [creating, setCreating] = useState(false);
	const handleCreated = useCallback(
		(scheduleId: string) => {
			setCreating(false);
			onOpenScheduleDetail(scheduleId);
		},
		[onOpenScheduleDetail],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader back={{ to: "chat", onClick: onBack }} title="Schedules" />

			<div className="min-h-0 flex-1 overflow-auto">
				<div className="mx-auto max-w-2xl px-4 py-4">
					{isLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="size-5 animate-spin text-th-text-muted" />
						</div>
					) : error ? (
						<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-th-error">
							<AlertCircle className="size-5" />
							<p>{error}</p>
						</div>
					) : sorted.length === 0 ? (
						<div className="space-y-1 py-8 text-center text-sm">
							<p className="text-th-text-secondary">No schedules yet.</p>
							<p className="text-th-text-muted">
								A schedule starts an agent on the same prompt on a timetable.
								Add one with the button below.
							</p>
						</div>
					) : (
						// Space, not a border, separates the cards (docs/project-ui.md §3).
						<ul className="space-y-2">
							{sorted.map((schedule) => (
								<li key={schedule.id}>
									<ScheduleRow
										schedule={schedule}
										serverZone={serverZone}
										onOpen={onOpenScheduleDetail}
									/>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>

			{/* Usable while the list loads or fails, as `New Role` is: creating does
			    not depend on the list, and a failure is reported in the sheet. */}
			<BottomActionBar>
				<button
					type="button"
					onClick={() => setCreating(true)}
					className="mx-auto flex min-h-[44px] w-full max-w-2xl items-center justify-center gap-2 rounded-lg bg-th-accent text-sm font-medium text-th-accent-text"
				>
					<Plus className="size-4" />
					New Schedule
				</button>
			</BottomActionBar>

			{creating && (
				<CreateScheduleSheet
					onClose={() => setCreating(false)}
					onCreated={handleCreated}
				/>
			)}
		</div>
	);
}

/**
 * The failure first: while it is set it is the schedule's current state, and
 * the latest run is an older attempt. The run half is `WorkRow`'s own rule.
 */
function scheduleEdgeClass(schedule: ScheduleListItem): string {
	if (schedule.last_failure) return "border-l-th-error";
	if (schedule.last_run) return workEdgeClass(schedule.last_run);
	return "border-l-th-border";
}

function ScheduleRow({
	schedule,
	serverZone,
	onOpen,
}: {
	schedule: ScheduleListItem;
	serverZone: ServerZone | null;
	onOpen: (scheduleId: string) => void;
}) {
	const { busy, error, toggle } = useScheduleEnabledToggle(schedule);
	const errorId = useId();

	const zoneSuffix = serverZone
		? periodZoneSuffix(serverZone, deviceOffsetSeconds())
		: "";

	return (
		// The work row's card idiom, edge and all: a schedule has a state — its latest
		// run's — so unlike a role card the edge is kept.
		<div
			className={`relative rounded-lg border border-th-border border-l-2 bg-th-bg-secondary px-3 hover:bg-th-bg-tertiary ${scheduleEdgeClass(schedule)}`}
		>
			<div className="flex min-h-[44px] items-center gap-3">
				<h2 className="min-w-0 flex-1 text-sm font-normal">
					{/* The whole card is the tap target, as on a work row; the switch
					    lifts itself above the overlay. */}
					<button
						type="button"
						onClick={() => onOpen(schedule.id)}
						className="flex min-h-[44px] w-full items-center text-left text-sm text-th-text-primary after:absolute after:inset-0 after:content-[''] hover:text-th-accent"
					>
						<span className="truncate">{schedule.title}</span>
					</button>
				</h2>
				<span className="relative z-10 flex">
					<Switch
						checked={schedule.enabled}
						onToggle={toggle}
						busy={busy}
						label={`Run "${schedule.title}" on schedule`}
						describedBy={error ? errorId : undefined}
					/>
				</span>
			</div>

			{/* The period first: it is what this schedule is, and "next" is
			    derived from it. Clipped from the right, never wrapped. */}
			<div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs">
				<span className="shrink-0 text-th-text-secondary">
					<PeriodWords cron={schedule.cron} />
					{zoneSuffix}
				</span>
				<NextRun schedule={schedule} />
			</div>

			<div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap pb-1.5 text-xs">
				<LatestRun schedule={schedule} />
			</div>

			{error && (
				<p
					id={errorId}
					className="pb-1.5 text-xs break-words text-th-error"
					role="alert"
				>
					{error}
				</p>
			)}
		</div>
	);
}

function NextRun({ schedule }: { schedule: ScheduleListItem }) {
	const text = !schedule.enabled
		? "Off"
		: schedule.next_run_at
			? `Next ${formatRelativeFuture(schedule.next_run_at)}`
			: null;
	if (!text) return null;
	return (
		<>
			<span aria-hidden="true" className="text-th-text-muted">
				&middot;
			</span>
			<span className="shrink-0 text-th-text-muted">{text}</span>
		</>
	);
}

/**
 * Line 3: what the latest run is doing, or that it could not be made. The
 * failure's message is the detail page's; a sentence on a line that clips
 * would arrive as its first two words. The label is untinted and the glyph
 * carries the tone (docs/project-ui.md §3).
 */
function LatestRun({ schedule }: { schedule: ScheduleListItem }) {
	const age = (iso: string): ReactNode => (
		<>
			<span aria-hidden="true">&middot;</span>
			<span className="shrink-0">{formatRelativeDate(iso)}</span>
		</>
	);

	if (schedule.last_failure) {
		return (
			<span className="flex items-center gap-1.5 text-th-text-secondary">
				<AlertCircle
					className="size-3.5 shrink-0 text-th-error"
					aria-hidden="true"
				/>
				<span>Last run failed</span>
				<span className="flex items-center gap-1.5 text-th-text-muted">
					{age(schedule.last_failure.at)}
				</span>
			</span>
		);
	}

	const run = schedule.last_run;
	if (run) {
		const unanswered = run.unanswered_questions ?? 0;
		return (
			<span className="flex items-center gap-1.5 text-th-text-secondary">
				<ActivityIcon activity={run.activity} size="sm" decorative />
				<span>{ACTIVITY_VIEW[run.activity].label}</span>
				{unanswered > 0 && (
					<>
						<span aria-hidden="true">&middot;</span>
						<span>{`${unanswered} to answer`}</span>
					</>
				)}
				{schedule.last_run_at && (
					<span className="flex items-center gap-1.5 text-th-text-muted">
						{age(schedule.last_run_at)}
					</span>
				)}
			</span>
		);
	}

	return (
		<span className="flex items-center gap-1.5 text-th-text-muted">
			{schedule.last_run_at ? (
				<>
					<span>Latest run deleted</span>
					{age(schedule.last_run_at)}
				</>
			) : (
				<span>No runs yet</span>
			)}
		</span>
	);
}
