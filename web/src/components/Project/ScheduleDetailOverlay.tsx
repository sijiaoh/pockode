import { ConfirmDialog } from "@pockode/shared";
import {
	AlertCircle,
	CircleCheck,
	Loader2,
	Pencil,
	Play,
	Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useDeviceTimeZone } from "../../hooks/useDeviceTimeZone";
import { useInlineEdit } from "../../hooks/useInlineEdit";
import { useIsScheduleDone } from "../../hooks/useIsScheduleDone";
import { useRoleNameMap } from "../../hooks/useRoleNameMap";
import { useScheduleDetailSubscription } from "../../hooks/useScheduleDetailSubscription";
import { useScheduleEnabledToggle } from "../../hooks/useScheduleEnabledToggle";
import { useWorktreeList } from "../../hooks/useWorktreeList";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { roleAcceptsWorkType, WORK_TYPE_PLURAL } from "../../lib/roleWorkType";
import {
	describePeriod,
	formatClock,
	formatDayDate,
	samePeriod,
} from "../../lib/schedulePeriod";
import { useScheduleStore } from "../../lib/scheduleStore";
import {
	instantZoneLabel,
	isKnownZone,
	parseWallClock,
	sameZone,
	zonedInstant,
	zoneLabel,
	zoneLine,
	zoneName,
} from "../../lib/scheduleZone";
import { useIsGitRepo } from "../../lib/worktreeStore";
import { useWSStore } from "../../lib/wsStore";
import type { Period, Schedule, ScheduleRunItem } from "../../types/schedule";
import { formatNextRun, formatRelativeFuture } from "../../utils/relativeTime";
import PageHeader from "../Layout/PageHeader";
import { MarkdownContent } from "../ui";
import BottomActionBar from "../ui/BottomActionBar";
import InlineEditableHeading from "../ui/InlineEditableHeading";
import { inputClass } from "../ui/inputClass";
import Skeleton from "../ui/Skeleton";
import Switch from "../ui/Switch";
import PeriodField from "./PeriodField";
import PeriodWords from "./PeriodWords";
import RoleSelect from "./RoleSelect";
import WorkRow from "./WorkRow";
import ZoneLabel from "./ZoneLabel";

interface Props {
	scheduleId: string;
	onBack: () => void;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}

/**
 * One schedule. Keyed by id, as the work detail is, so that a page reused for
 * another schedule cannot carry the first one's half-made edits across. What
 * the page holds is docs/schedule-ui.md §4.
 */
export default function ScheduleDetailOverlay({ scheduleId, ...rest }: Props) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				back={{
					to: "parent",
					label: "Back to schedules",
					onClick: rest.onBack,
				}}
				title="Schedule"
			/>
			<ScheduleDetailPage key={scheduleId} scheduleId={scheduleId} {...rest} />
		</div>
	);
}

/** Runs shown before the first `Show more runs`: Prompt stays in reach on a phone. */
const FIRST_RUNS = 5;
const MORE_RUNS = 20;

function ScheduleDetailPage({
	scheduleId,
	onBack,
	onOpenWorkDetail,
	onNavigateToSession,
}: Props) {
	const detail = useScheduleDetailSubscription(scheduleId);
	const { schedule, loading, error } = detail;
	const done = useIsScheduleDone(schedule);

	// The detail subscription sends nothing on delete, so a deletion reaches an
	// open page through the list (docs/schedule-ui.md §4.4). Only a loaded list
	// can say so: it starts out loading and goes back to loading on reconnect.
	const goneFromList = useScheduleStore(
		(s) =>
			!s.isLoading &&
			!s.error &&
			!s.schedules.some((item) => item.id === scheduleId),
	);

	if (loading && !goneFromList) return <DetailSkeleton />;

	if (error || !schedule || goneFromList) {
		const notFound =
			goneFromList || !error || /schedule not found/i.test(error);
		return (
			<div
				className={`flex flex-1 flex-col items-center justify-center gap-2 text-sm ${notFound ? "text-th-text-muted" : "text-th-error"}`}
			>
				<AlertCircle className="size-5" />
				<p>{notFound ? "Schedule not found" : error}</p>
			</div>
		);
	}

	return (
		<>
			<div className="min-h-0 flex-1 overflow-auto">
				{/* What changes goes above what does not, the work detail's rule:
				    the state and the runs are what a schedule is opened for. */}
				<div className="mx-auto max-w-2xl space-y-5 px-4 py-4">
					<div>
						<ScheduleTitle schedule={schedule} />
						{done ? (
							<DoneLine schedule={schedule} />
						) : (
							<EnabledLine schedule={schedule} />
						)}
						<Notice
							schedule={schedule}
							done={done}
							runs={detail.runs}
							onOpenWorkDetail={onOpenWorkDetail}
						/>
					</div>
					<RunsSection
						schedule={schedule}
						done={done}
						runs={detail.runs}
						hasMoreRuns={detail.hasMoreRuns}
						loadMore={detail.loadMore}
						isLoadingMore={detail.isLoadingMore}
						loadMoreError={detail.loadMoreError}
						onOpenWorkDetail={onOpenWorkDetail}
						onNavigateToSession={onNavigateToSession}
					/>
					<PromptSection schedule={schedule} />
					<PeriodSection schedule={schedule} done={done} />
					<RoleSection schedule={schedule} />
					<WorktreeSection schedule={schedule} />
					<DeleteSection schedule={schedule} onDeleted={onBack} />
				</div>
			</div>
			<RunNowBar schedule={schedule} />
		</>
	);
}

function DetailSkeleton() {
	return (
		<div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-4">
			<Skeleton className="h-7 w-40 rounded" label="Schedule: loading" />
			<Skeleton className="h-5 w-56 rounded" />
			<Skeleton className="h-24 w-full rounded-lg" />
			<Skeleton className="h-16 w-full rounded-lg" />
		</div>
	);
}

function SectionHeading({ children }: { children: ReactNode }) {
	return (
		<h3 className="text-xs font-medium uppercase text-th-text-muted">
			{children}
		</h3>
	);
}

/**
 * One of the schedule's own instants — a firing, past or next — on the
 * period's clock, with the zone's label when that is not the device's
 * (docs/schedule-ui.md §6.5). A run's times are a work's and are not drawn
 * with this.
 */
function ScheduleInstant({
	iso,
	schedule,
}: {
	iso: string;
	schedule: Schedule;
}) {
	const deviceZone = useDeviceTimeZone();
	return (
		<>
			{formatNextRun(iso, undefined, schedule.time_zone)}
			<ZoneLabel label={instantZoneLabel(schedule.time_zone, deviceZone)} />
		</>
	);
}

/**
 * A one-time's own time, drawn as its instants are. A done schedule has no
 * `next_run_at` to draw, so this is the period's `at`; in a zone the browser
 * cannot convert, the wall clock as stored with the raw zone, since it is the
 * schedule's time as written (docs/schedule-ui.md §6.6).
 */
function OnceAt({ at, schedule }: { at: string; schedule: Schedule }) {
	const instant = zonedInstant(at, schedule.time_zone);
	if (instant !== null) {
		return (
			<ScheduleInstant
				iso={new Date(instant).toISOString()}
				schedule={schedule}
			/>
		);
	}
	const wall = parseWallClock(at);
	return (
		<>
			{wall
				? `${formatDayDate(wall)} ${formatClock(wall.hour, wall.minute)}`
				: at}
			<ZoneLabel label={schedule.time_zone} />
		</>
	);
}

/** The one-time `at`, for a schedule the caller knows is a one-time. */
const onceAt = (schedule: Schedule) =>
	schedule.period.kind === "once" ? schedule.period.at : "";

function useUpdateSchedule() {
	return useWSStore((s) => s.actions.updateSchedule);
}

function ScheduleTitle({ schedule }: { schedule: Schedule }) {
	const updateSchedule = useUpdateSchedule();
	return (
		<InlineEditableHeading
			value={schedule.title}
			onSave={useCallback(
				(trimmed: string) =>
					updateSchedule({ id: schedule.id, title: trimmed }),
				[updateSchedule, schedule.id],
			)}
			label="Title"
		/>
	);
}

/** The switch and what it means right now: when the next firing is, or that there is none. */
function EnabledLine({ schedule }: { schedule: Schedule }) {
	const { busy, error, toggle } = useScheduleEnabledToggle(schedule);
	const errorId = useId();
	const deviceZone = useDeviceTimeZone();

	const next = schedule.next_run_at;
	// A one-time has no run after this one to make it the "next".
	const nextLabel = schedule.period.kind === "once" ? "Runs" : "Next run";
	let state: ReactNode;
	if (!schedule.enabled) {
		state = "Off · Runs only when you press Run now";
	} else if (!next) {
		state = "On";
	} else if (instantZoneLabel(schedule.time_zone, deviceZone) === null) {
		state = `On · ${nextLabel} ${formatNextRun(next, undefined, schedule.time_zone)} (${formatRelativeFuture(next)})`;
	} else {
		// The zone label takes the brackets, so the relative half leaves them:
		// one pair on the line (docs/schedule-ui.md §6.5).
		state = (
			<>
				On · {nextLabel} <ScheduleInstant iso={next} schedule={schedule} /> ·{" "}
				{formatRelativeFuture(next)}
			</>
		);
	}

	return (
		<div className="mt-1">
			<div className="flex min-h-[44px] items-center gap-3">
				<Switch
					checked={schedule.enabled}
					onToggle={toggle}
					busy={busy}
					label={`Run "${schedule.title}" on schedule`}
					describedBy={error ? errorId : undefined}
				/>
				<span className="min-w-0 text-sm text-th-text-secondary">{state}</span>
			</div>
			{error && (
				<p id={errorId} className="text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * What a done one-time says in place of the switch line: when it was due —
 * true whether it ran, failed, was skipped or was off — and how to run it
 * again (docs/schedule-ui.md §6.6).
 */
function DoneLine({ schedule }: { schedule: Schedule }) {
	return (
		<div className="mt-1">
			<p className="flex min-h-[44px] items-center gap-1.5 text-sm text-th-text-secondary">
				<CircleCheck
					className="size-4 shrink-0 text-th-text-muted"
					aria-hidden="true"
				/>
				<span className="min-w-0">
					Done · Was due <OnceAt at={onceAt(schedule)} schedule={schedule} />
				</span>
			</p>
			<p className="text-xs text-th-text-muted">
				To run it again, set a new time under Period.
			</p>
		</div>
	);
}

/**
 * At most one line about the schedule's state, in order of precedence: a run
 * that could not be made or started, a run going now, a firing skipped
 * (docs/schedule-ui.md §4.1).
 */
function Notice({
	schedule,
	done,
	runs,
	onOpenWorkDetail,
}: {
	schedule: Schedule;
	done: boolean;
	runs: ScheduleRunItem[];
	onOpenWorkDetail: (workId: string) => void;
}) {
	const failure = schedule.last_failure;
	if (failure) {
		const workId = failure.work_id;
		return (
			<div
				className="mt-2 rounded-lg border border-th-error px-3 py-2 text-sm"
				role="alert"
			>
				<p className="flex items-center gap-1.5 text-th-text-primary">
					<AlertCircle
						className="size-4 shrink-0 text-th-error"
						aria-hidden="true"
					/>
					<span>
						The run at <ScheduleInstant iso={failure.at} schedule={schedule} />{" "}
						{workId ? "could not be started." : "could not be made."}
					</span>
				</p>
				<p className="mt-1 break-words text-xs text-th-text-secondary">
					{failure.error}
				</p>
				{workId && (
					<button
						type="button"
						onClick={() => onOpenWorkDetail(workId)}
						className="mt-1 flex min-h-[44px] items-center text-sm text-th-accent hover:underline"
					>
						Open the run
					</button>
				)}
			</div>
		);
	}

	// The latest run as the loaded page has it: it is the newest made, so it
	// is on the first page whenever it still exists.
	const latest = runs.find((run) => run.id === schedule.last_run_work_id);
	if (latest?.status === "active") {
		// Said ahead and not enforced: the server decides, and Run now stays
		// enabled (the agent-role delete rule).
		return (
			<p className="mt-2 text-xs text-th-text-muted">
				A run is going now. Run now is refused until it ends.
			</p>
		);
	}

	const skipped = schedule.last_skipped_at;
	if (
		skipped &&
		(!schedule.last_run_at ||
			Date.parse(skipped) > Date.parse(schedule.last_run_at))
	) {
		return done ? (
			<p className="mt-2 text-xs text-th-text-muted">
				Did not run at <ScheduleInstant iso={skipped} schedule={schedule} />: a
				run started earlier was still going.
			</p>
		) : (
			<p className="mt-2 text-xs text-th-text-muted">
				Skipped the run at <ScheduleInstant iso={skipped} schedule={schedule} />
				: the previous one was still going.
			</p>
		);
	}

	if (done && !schedule.enabled) {
		return (
			<p className="mt-2 text-xs text-th-text-muted">
				It was off at <OnceAt at={onceAt(schedule)} schedule={schedule} />, so
				it did not run.
			</p>
		);
	}

	return null;
}

/**
 * Runs once made and since deleted are not "no runs yet": `last_run_at` says
 * one was made (the list row's `Latest run deleted`, docs/schedule-ui.md §11).
 */
function emptyRunsText(schedule: Schedule, done: boolean): ReactNode {
	if (schedule.last_run_at) return "Its runs have been deleted.";
	return !done && schedule.enabled && schedule.next_run_at ? (
		<>
			No runs yet. {schedule.period.kind === "once" ? "It is" : "The first is"}{" "}
			due <ScheduleInstant iso={schedule.next_run_at} schedule={schedule} />.
		</>
	) : (
		"No runs yet. Press Run now to make one."
	);
}

/**
 * The runs, each a `WorkRow` unchanged: a run is a work, so it is stopped,
 * restarted, reopened and chatted with from here exactly as a story is from
 * the list (docs/schedule-ui.md §4.2).
 */
function RunsSection({
	schedule,
	done,
	runs,
	hasMoreRuns,
	loadMore,
	isLoadingMore,
	loadMoreError,
	onOpenWorkDetail,
	onNavigateToSession,
}: {
	schedule: Schedule;
	done: boolean;
	runs: ScheduleRunItem[];
	hasMoreRuns: boolean;
	loadMore: () => Promise<void>;
	isLoadingMore: boolean;
	loadMoreError: string | null;
	onOpenWorkDetail: (workId: string) => void;
	onNavigateToSession: (sessionId: string, worktree: string) => void;
}) {
	const roleNameMap = useRoleNameMap();
	const [shown, setShown] = useState(FIRST_RUNS);

	const showMore = useCallback(() => {
		if (isLoadingMore) return;
		const next = shown + MORE_RUNS;
		setShown(next);
		if (next > runs.length && hasMoreRuns) void loadMore();
	}, [isLoadingMore, shown, runs.length, hasMoreRuns, loadMore]);

	const visible = runs.slice(0, shown);
	const canShowMore = shown < runs.length || hasMoreRuns;

	return (
		<div>
			<div className="mb-1">
				<SectionHeading>Runs</SectionHeading>
			</div>
			{runs.length === 0 ? (
				<p className="py-2 text-sm text-th-text-muted">
					{emptyRunsText(schedule, done)}
				</p>
			) : (
				<div className="space-y-2">
					{visible.map((run) => (
						// Under the Runs heading, so `h4`, as a story's Tasks rows are.
						// Dated by when each was made: the order the runs are in.
						<WorkRow
							key={run.id}
							work={run}
							roleName={
								run.agent_role_id
									? roleNameMap.get(run.agent_role_id)
									: undefined
							}
							dateAt={run.created_at}
							headingLevel={4}
							onOpen={onOpenWorkDetail}
							onOpenChat={onNavigateToSession}
						/>
					))}
				</div>
			)}
			{loadMoreError ? (
				<div className="mt-2 flex items-center gap-2">
					<p className="min-w-0 flex-1 text-xs text-th-error" role="alert">
						{loadMoreError}
					</p>
					<button
						type="button"
						onClick={() => void loadMore()}
						className="flex min-h-[44px] shrink-0 items-center rounded-lg px-3 text-sm text-th-accent hover:bg-th-bg-tertiary"
					>
						Retry
					</button>
				</div>
			) : (
				canShowMore && (
					// Its own 8px clearance from the last card, as `Show earlier
					// work` has (docs/project-ui.md §2.3). Busy, never disabled, so
					// the focus a keyboard press put here stays here.
					<button
						type="button"
						onClick={showMore}
						aria-busy={isLoadingMore || undefined}
						className={`mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg text-sm text-th-text-secondary hover:bg-th-bg-tertiary${isLoadingMore ? " cursor-wait" : ""}`}
					>
						{isLoadingMore && <Loader2 className="size-4 animate-spin" />}
						Show more runs
					</button>
				)
			)}
		</div>
	);
}

function PromptSection({ schedule }: { schedule: Schedule }) {
	const updateSchedule = useUpdateSchedule();
	const {
		editing,
		setEditing,
		value,
		setValue,
		saving,
		error,
		ref,
		save,
		cancel,
	} = useInlineEdit<HTMLTextAreaElement>({
		initialValue: schedule.prompt,
		onSave: useCallback(
			(trimmed: string) => updateSchedule({ id: schedule.id, prompt: trimmed }),
			[updateSchedule, schedule.id],
		),
	});

	return (
		<div>
			<div className="flex items-center justify-between">
				<SectionHeading>Prompt</SectionHeading>
				{!editing && (
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted opacity-80 transition-opacity hover:opacity-100 hover:bg-th-bg-tertiary hover:text-th-text-primary"
						aria-label="Edit prompt"
					>
						<Pencil className="size-3.5" />
					</button>
				)}
			</div>
			<p className="mb-1.5 text-xs text-th-text-muted">
				Every run starts with this prompt.
			</p>
			{editing ? (
				<>
					<TextareaAutosize
						ref={ref}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") cancel();
						}}
						disabled={saving}
						aria-label="Prompt"
						minRows={4}
						className={`w-full resize-none rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
					/>
					<SaveCancel
						onSave={save}
						onCancel={cancel}
						saving={saving}
						// The server requires a prompt: an empty one is not a save.
						canSave={value.trim() !== ""}
					/>
					{error && (
						<p className="mt-1 text-xs text-th-error" role="alert">
							{error}
						</p>
					)}
				</>
			) : (
				// `.code-block` leaves sideways scrolling to an ancestor; without
				// this one a wide line would slide the whole page.
				<div className="overflow-x-auto rounded-lg bg-th-bg-secondary px-3 py-2">
					<MarkdownContent content={schedule.prompt} />
				</div>
			)}
		</div>
	);
}

function SaveCancel({
	onSave,
	onCancel,
	saving,
	canSave,
	saveLabel = "Save",
}: {
	onSave: () => void;
	onCancel: () => void;
	saving: boolean;
	canSave: boolean;
	saveLabel?: string;
}) {
	return (
		<div className="mt-2 flex items-center gap-2">
			<button
				type="button"
				onClick={onSave}
				disabled={saving || !canSave}
				className="min-h-[44px] rounded-lg bg-th-accent px-4 text-sm font-medium text-th-accent-text disabled:opacity-50"
			>
				{saving ? "Saving..." : saveLabel}
			</button>
			<button
				type="button"
				onClick={onCancel}
				disabled={saving}
				className="min-h-[44px] rounded-lg px-4 text-sm text-th-text-muted hover:bg-th-bg-tertiary"
			>
				Cancel
			</button>
		</div>
	);
}

/**
 * The period in words, in the schedule's zone, and the one editor for it. Save
 * sends `period` only when the field wrote something other than what is
 * stored: a period opened and saved untouched sends nothing
 * (docs/schedule-ui.md §6.1). It never sends `time_zone`, so an edit made
 * while travelling keeps the schedule where it was. On a done one-time it also
 * turns the schedule on: a new time for a finished one-time is meant to run
 * (§6.6); on any other schedule `enabled` is left alone.
 */
function PeriodSection({
	schedule,
	done,
}: {
	schedule: Schedule;
	done: boolean;
}) {
	const deviceZone = useDeviceTimeZone();
	const zonesDiffer = !sameZone(schedule.time_zone, deviceZone);
	const updateSchedule = useUpdateSchedule();
	const [editing, setEditing] = useState(false);
	// `undefined` until the field reports an edit; `null` while it spells nothing.
	const [draft, setDraft] = useState<Period | null | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const close = useCallback(() => {
		setEditing(false);
		setDraft(undefined);
		setError(null);
	}, []);

	const save = useCallback(async () => {
		if (draft === null) return;
		if (draft === undefined || samePeriod(draft, schedule.period)) {
			close();
			return;
		}
		setError(null);
		setSaving(true);
		try {
			await updateSchedule({
				id: schedule.id,
				period: draft,
				...(done ? { enabled: true } : {}),
			});
			close();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setSaving(false);
		}
	}, [draft, schedule.period, schedule.id, done, updateSchedule, close]);

	return (
		<div>
			{/* While editing, the field's own "Period" label shows as the heading:
			    both would print the same word twice. The heading stays for the
			    outline a screen reader navigates by. */}
			{editing ? (
				<h3 className="sr-only">Period</h3>
			) : (
				<div className="flex items-center justify-between">
					<SectionHeading>Period</SectionHeading>
					<button
						type="button"
						onClick={() => setEditing(true)}
						className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-th-text-muted opacity-80 transition-opacity hover:opacity-100 hover:bg-th-bg-tertiary hover:text-th-text-primary"
						aria-label="Edit period"
					>
						<Pencil className="size-3.5" />
					</button>
				</div>
			)}
			{editing ? (
				<>
					{/* Held still while saving: closing on success would otherwise drop
					    an edit made during the request without a word. */}
					<fieldset disabled={saving} className="min-w-0">
						<PeriodField
							initial={schedule.period}
							onChange={setDraft}
							timeZone={schedule.time_zone}
						/>
					</fieldset>
					<SaveCancel
						onSave={save}
						onCancel={close}
						saving={saving}
						// A done one-time opens on the time that passed: there is
						// nothing to save until the user picks another (§6.6).
						canSave={draft !== null && !(done && draft === undefined)}
						saveLabel={done ? "Save and turn on" : "Save"}
					/>
					{error && (
						<p className="mt-1 break-words text-xs text-th-error" role="alert">
							{error}
						</p>
					)}
				</>
			) : (
				<>
					<p className="text-sm text-th-text-primary">
						<PeriodWords schedule={schedule} withZone={false} />
					</p>
					{/* The label is not appended to the words here: the zone line
					    under them says it at length. */}
					{zonesDiffer && (
						<>
							<p className="text-xs text-th-text-muted">
								{zoneLine(schedule.time_zone, deviceZone)}
							</p>
							{/* A device that reports no real zone (`Etc/Unknown`) has
							    none to offer: the server would only refuse it. */}
							{/* Nothing more will run in either zone once it is done. */}
							{isKnownZone(deviceZone) && !done && (
								<UseDeviceZoneButton
									schedule={schedule}
									deviceZone={deviceZone}
								/>
							)}
						</>
					)}
				</>
			)}
		</div>
	);
}

/**
 * Moves the schedule to the device's zone, the period as stored: `09:00` is then
 * read on this device's clock. It confirms because nothing here can undo it —
 * there is no zone picker, so only a device in the old zone can switch back.
 * The button goes when the notification brings the new zone, not on the
 * reply, so the page never shows a zone the subscription does not hold
 * (docs/schedule-ui.md §6.5).
 */
function UseDeviceZoneButton({
	schedule,
	deviceZone,
}: {
	schedule: Schedule;
	deviceZone: string;
}) {
	const updateSchedule = useUpdateSchedule();
	const [confirming, setConfirming] = useState(false);
	const deviceCity = zoneLabel(deviceZone);
	const scheduleCity = zoneLabel(schedule.time_zone);
	const action = `Use ${deviceCity} time`;

	const handleConfirm = useCallback(async () => {
		await updateSchedule({ id: schedule.id, time_zone: deviceZone });
		setConfirming(false);
	}, [updateSchedule, schedule.id, deviceZone]);

	return (
		<>
			<button
				type="button"
				onClick={() => setConfirming(true)}
				className="flex min-h-[44px] items-center text-sm text-th-accent hover:underline"
			>
				{action}
			</button>
			{confirming && (
				<ConfirmDialog
					title={`Run on ${deviceCity} time?`}
					message={`"${describePeriod(schedule.period, schedule.time_zone)}" will run on ${zoneName(deviceZone)} instead of ${zoneName(schedule.time_zone)}. Only a device on ${scheduleCity} time can switch it back.`}
					confirmLabel={action}
					onConfirm={handleConfirm}
					onCancel={() => setConfirming(false)}
				/>
			)}
		</>
	);
}

/**
 * Applied on change, like the work detail's Role. The kind of work a role
 * takes is judged when it is assigned and never again on the run path, so a
 * kept role that no longer takes jobs is said, not flagged; a deleted one is
 * what makes the next firing fail (docs/schedule-ui.md §4.3).
 */
function RoleSection({ schedule }: { schedule: Schedule }) {
	const updateSchedule = useUpdateSchedule();
	const roles = useAgentRoleStore((s) => s.roles);
	const rolesLoading = useAgentRoleStore((s) => s.isLoading);
	const rolesError = useAgentRoleStore((s) => s.error);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fieldId = useId();

	const role = useMemo(
		() => roles.find((r) => r.id === schedule.agent_role_id),
		[roles, schedule.agent_role_id],
	);

	const handleChange = useCallback(
		async (roleId: string) => {
			if (!roleId || roleId === schedule.agent_role_id) return;
			setError(null);
			setSaving(true);
			try {
				await updateSchedule({ id: schedule.id, agent_role_id: roleId });
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to update role");
			} finally {
				setSaving(false);
			}
		},
		[schedule.id, schedule.agent_role_id, updateSchedule],
	);

	// A role list that has not arrived says nothing about whether the role exists.
	const note = !role
		? !rolesLoading && !rolesError
			? "This role has been deleted. Runs will fail until you pick another."
			: null
		: role.work_type && !roleAcceptsWorkType(role, "job")
			? `${role.name} only takes ${WORK_TYPE_PLURAL[role.work_type]}. Runs keep using it until you change it.`
			: null;

	return (
		<div>
			<div className="mb-1">
				<SectionHeading>
					<label htmlFor={fieldId}>Role</label>
				</SectionHeading>
			</div>
			<div className="flex items-center gap-2">
				<RoleSelect
					id={fieldId}
					value={schedule.agent_role_id}
					workType="job"
					onChange={handleChange}
					disabled={saving}
				/>
				{saving && (
					<Loader2 className="size-4 shrink-0 animate-spin text-th-text-muted" />
				)}
			</div>
			{note && <p className="mt-1 text-xs text-th-text-muted">{note}</p>}
			{error && (
				<p className="mt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * Drawn only in a git repository: outside one the server takes no worktree
 * but main, so there is nothing to choose.
 */
function WorktreeSection({ schedule }: { schedule: Schedule }) {
	const isGitRepo = useIsGitRepo();
	const worktrees = useWorktreeList();
	const updateSchedule = useUpdateSchedule();
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fieldId = useId();

	const stored = schedule.worktree ?? "";
	const others = worktrees.filter((w) => !w.is_main).map((w) => w.name);
	// An empty list is one that has not arrived — main is always in a loaded one.
	const isDeleted =
		stored !== "" && worktrees.length > 0 && !others.includes(stored);

	const handleChange = useCallback(
		async (worktree: string) => {
			if (worktree === stored) return;
			setError(null);
			setSaving(true);
			try {
				await updateSchedule({ id: schedule.id, worktree });
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to update worktree",
				);
			} finally {
				setSaving(false);
			}
		},
		[schedule.id, stored, updateSchedule],
	);

	if (isGitRepo !== true) return null;

	return (
		<div>
			<div className="mb-1">
				<SectionHeading>
					<label htmlFor={fieldId}>Worktree</label>
				</SectionHeading>
			</div>
			<div className="flex items-center gap-2">
				<select
					id={fieldId}
					value={stored}
					onChange={(e) => handleChange(e.target.value)}
					disabled={saving}
					className={`min-h-[44px] w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary ${inputClass}`}
				>
					<option value="">main</option>
					{others.map((name) => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
					{/* Before the list arrives the stored one is offered as itself,
					    so the field never shows a worktree that is not the stored one. */}
					{stored !== "" && !others.includes(stored) && (
						<option value={stored}>
							{isDeleted ? `${stored} (deleted)` : stored}
						</option>
					)}
				</select>
				{saving && (
					<Loader2 className="size-4 shrink-0 animate-spin text-th-text-muted" />
				)}
			</div>
			{isDeleted && (
				<p className="mt-1 text-xs text-th-text-muted">
					Runs will fail until you pick a worktree that exists.
				</p>
			)}
			{error && (
				<p className="mt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

/**
 * At the end and in a plain text button, as `Delete role` is: deleting is
 * rare, and weight follows frequency. The server deletes the schedule alone,
 * which the dialog says because it is true and surprising.
 */
function DeleteSection({
	schedule,
	onDeleted,
}: {
	schedule: Schedule;
	onDeleted: () => void;
}) {
	const deleteSchedule = useWSStore((s) => s.actions.deleteSchedule);
	const [showConfirm, setShowConfirm] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		setError(null);
		try {
			await deleteSchedule(schedule.id);
			onDeleted();
		} catch (err) {
			setError(
				`Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
			);
			setShowConfirm(false);
		}
	}, [deleteSchedule, schedule.id, onDeleted]);

	return (
		<div className="border-t border-th-border pt-5">
			<button
				type="button"
				onClick={() => setShowConfirm(true)}
				className="flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-sm text-th-error hover:bg-th-error/10"
			>
				<Trash2 className="size-4" />
				Delete schedule
			</button>
			{error && (
				<p className="mt-1 text-xs text-th-error" role="alert">
					{error}
				</p>
			)}
			{showConfirm && (
				<ConfirmDialog
					title={`Delete "${schedule.title}"?`}
					message="It will not run again. The runs it already made stay, each with its chat, and a run in progress keeps going."
					confirmLabel="Delete"
					variant="danger"
					onConfirm={handleDelete}
					onCancel={() => setShowConfirm(false)}
				/>
			)}
		</div>
	);
}

/**
 * Run now stays on the page: the new run arrives at the top of Runs with the
 * detail's next notification, Chat icon and all. It works on a disabled
 * schedule too — the server allows it, and the Off line says so.
 */
function RunNowBar({ schedule }: { schedule: Schedule }) {
	const runSchedule = useWSStore((s) => s.actions.runSchedule);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = useCallback(async () => {
		setError(null);
		setBusy(true);
		try {
			await runSchedule(schedule.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to run");
		} finally {
			setBusy(false);
		}
	}, [runSchedule, schedule.id]);

	return (
		<BottomActionBar>
			<div className="mx-auto max-w-2xl">
				{error && (
					<p className="mb-1.5 text-xs text-th-error" role="alert">
						{error}
					</p>
				)}
				<button
					type="button"
					onClick={run}
					disabled={busy}
					className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-accent text-sm font-medium text-th-accent-text disabled:opacity-50"
				>
					{busy ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Play className="size-4" />
					)}
					Run now
				</button>
			</div>
		</BottomActionBar>
	);
}
