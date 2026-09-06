import { ChevronRight, ExternalLink, Loader2, Play } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type { WorkCardMessage, WorkTimelineEntry } from "../../types/message";
import type { Work } from "../../types/work";
import {
	groupTimelineEntries,
	type TimelineGroup,
	timelineGroupLabel,
} from "../../utils/systemMessage";
import {
	formatStepCount,
	formatStepProgress,
	getStepProgress,
	recordedStepProgress,
} from "../../utils/workSteps";
import StepList from "../Project/StepList";
import { ScrollableContent } from "../ui";
import StatusBadge, { statusLabels } from "../ui/StatusBadge";
import StatusIcon from "../ui/StatusIcon";
import { MarkdownContent } from "./MarkdownContent";

interface TimelineGroupItemProps {
	group: TimelineGroup;
}

function TimelineGroupItem({ group }: TimelineGroupItemProps) {
	const [expanded, setExpanded] = useState(false);
	const label = timelineGroupLabel(group);

	return (
		<li>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded p-1.5 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<span className="min-w-0 truncate text-th-text-muted">{label}</span>
			</button>
			{expanded && (
				<div className="space-y-2 border-l border-th-border pb-2 pl-4">
					{group.entries.map((entry: WorkTimelineEntry) => (
						<MarkdownContent key={entry.id} content={entry.content} />
					))}
				</div>
			)}
		</li>
	);
}

interface WaitingChildrenProps {
	childWorks: Work[];
	onOpenWorkDetail?: (workId: string) => void;
}

function WaitingChildren({
	childWorks,
	onOpenWorkDetail,
}: WaitingChildrenProps) {
	return (
		<div>
			<h4 className="mb-1 text-xs font-medium uppercase text-th-text-muted">
				Waiting on
			</h4>
			<ul className="space-y-1">
				{childWorks.map((child) => (
					<li key={child.id}>
						<button
							type="button"
							onClick={() => onOpenWorkDetail?.(child.id)}
							disabled={!onOpenWorkDetail}
							className="flex w-full items-center gap-1.5 rounded p-1.5 text-left hover:bg-th-overlay-hover disabled:hover:bg-transparent"
						>
							<StatusIcon status={child.status} size="sm" />
							<span className="min-w-0 truncate text-th-text-secondary">
								{child.title}
							</span>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

interface Props {
	message: WorkCardMessage;
	onOpenWorkDetail?: (workId: string) => void;
}

/**
 * One card per work, standing in for the run of system messages that work
 * produced. Its status comes from the work store rather than from any of those
 * messages: a message records what happened at a moment, and the question the
 * card has to answer — "is this still running?" — changes without one (an
 * interrupt stops a work silently). See docs/code/work-system.md.
 */
function WorkCardItem({ message, onOpenWorkDetail }: Props) {
	const { workId, entries } = message;
	const works = useWorkStore((s) => s.works);
	const work = works.find((w) => w.id === workId);
	const role = useAgentRoleStore((s) =>
		s.roles.find((r) => r.id === work?.agent_role_id),
	);
	const startWork = useWSStore((s) => s.actions.startWork);

	const status = work?.status;
	const [expanded, setExpanded] = useState(status === "needs_input");
	// The card keeps its identity as the work advances, so it never remounts.
	// Follow only the two transitions that change what the user needs to see and
	// leave the rest alone, or a manual expand could never survive.
	const [prevStatus, setPrevStatus] = useState(status);
	if (prevStatus !== status) {
		setPrevStatus(status);
		if (status === "needs_input") setExpanded(true);
		else if (status === "closed") setExpanded(false);
	}

	const [isStarting, setIsStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleRestart = useCallback(async () => {
		setError(null);
		setIsStarting(true);
		try {
			await startWork(workId);
		} catch (err) {
			setError(
				`Failed to restart: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setIsStarting(false);
		}
	}, [startWork, workId]);

	const openChildren = useMemo(
		() => works.filter((w) => w.parent_id === workId && w.status !== "closed"),
		[works, workId],
	);
	const groups = useMemo(() => groupTimelineEntries(entries), [entries]);

	const typeLabel =
		(work?.type ?? message.workType) === "story" ? "Story" : "Task";
	const title = work?.title ?? message.title ?? "";

	// Live position while the work exists. Once it is gone, the newest step any
	// of its messages recorded is the only trace left of where it stood — worth
	// showing, and honest as long as nothing else claims to be current.
	const recordedStep = entries.findLast((e) => e.step)?.step;
	const progress = work
		? getStepProgress(work, role)
		: recordedStep
			? recordedStepProgress(recordedStep.current, recordedStep.total)
			: null;

	// The suffix that qualifies the status: how far along, or what it waits on.
	let detail = "";
	if (status === "waiting" && openChildren.length > 0) {
		detail = `${openChildren.length} subtask${openChildren.length > 1 ? "s" : ""}`;
	} else if (progress) {
		detail =
			status === "closed"
				? formatStepCount(progress)
				: formatStepProgress(progress);
	}

	// Status reaches the eye as color and glyph, so the accessible name has to
	// spell it out. Commas rather than the visible "·": screen readers pause on a
	// comma and stumble over the dot.
	const ariaLabel = [
		typeLabel,
		status ? statusLabels[status] : "unknown status",
		detail,
		title,
	]
		.filter(Boolean)
		.join(", ");

	const steps = role?.steps ?? [];
	const needsAction = status === "needs_input";

	return (
		<div
			className={`rounded text-xs ${needsAction ? "border border-th-warning bg-th-warning/10" : "bg-th-bg-secondary"}`}
		>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				aria-label={ariaLabel}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				{/* Never a spinner, even for in_progress: here a spinner means "the
				    agent is producing this turn", and a work whose process sits idle
				    mid-step is a normal resting state. */}
				{status ? (
					<StatusIcon status={status} size="sm" />
				) : (
					<span className="size-3 shrink-0" />
				)}
				<span className="shrink-0 text-th-accent">{typeLabel}</span>
				{status ? (
					<span className="shrink-0">
						<StatusBadge status={status} />
					</span>
				) : (
					// The work is gone from the store; show what the messages recorded
					// and say nothing about a status we cannot know.
					<span className="shrink-0 text-th-text-muted">—</span>
				)}
				{detail && (
					<span className="shrink-0 text-th-text-muted">· {detail}</span>
				)}
				<span className="min-w-0 flex-1 truncate text-th-text-muted">
					{title}
				</span>
			</button>

			{expanded && (
				<ScrollableContent className="max-h-[60vh] space-y-3 overflow-auto border-t border-th-border p-2">
					<div className="flex items-start gap-2">
						<p className="min-w-0 flex-1 break-words text-sm text-th-text-primary">
							{title}
						</p>
						{onOpenWorkDetail && (
							<button
								type="button"
								onClick={() => onOpenWorkDetail(workId)}
								className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-th-accent hover:bg-th-overlay-hover"
							>
								<ExternalLink className="size-3" />
								Details
							</button>
						)}
					</div>

					{work && steps.length > 0 && (
						<StepList
							steps={steps}
							currentStep={progress?.currentStep ?? 0}
							workStatus={work.status}
						/>
					)}

					{status === "waiting" && openChildren.length > 0 && (
						<WaitingChildren
							childWorks={openChildren}
							onOpenWorkDetail={onOpenWorkDetail}
						/>
					)}

					<div>
						<h4 className="mb-1 text-xs font-medium uppercase text-th-text-muted">
							History
						</h4>
						<ul>
							{groups.map((group) => (
								<TimelineGroupItem key={group.id} group={group} />
							))}
						</ul>
					</div>
				</ScrollableContent>
			)}

			{error && (
				<p className="border-t border-th-border p-2 text-th-error" role="alert">
					{error}
				</p>
			)}

			{status === "stopped" && (
				<div className="flex justify-end border-t border-th-border p-2">
					<button
						type="button"
						onClick={handleRestart}
						disabled={isStarting}
						className="flex items-center gap-1 rounded bg-th-accent px-2 py-1 text-th-accent-text disabled:opacity-50"
					>
						{isStarting ? (
							<Loader2 className="size-3 animate-spin" />
						) : (
							<Play className="size-3" />
						)}
						Restart
					</button>
				</div>
			)}
		</div>
	);
}

export default WorkCardItem;
