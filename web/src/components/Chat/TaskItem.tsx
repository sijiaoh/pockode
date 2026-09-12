import { Ban, Check, ChevronRight, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TaskRun, TaskRunStatus } from "../../types/message";
import { CollapsibleBody, ScrollableContent, Spinner } from "../ui";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
	task: TaskRun;
}

// Running has no entry: it is the one state shown as a spinner, not an icon.
const statusConfig: Record<
	Exclude<TaskRunStatus, "running">,
	{ Icon: typeof Check; color: string; label: string }
> = {
	done: { Icon: Check, color: "text-th-success", label: "done" },
	failed: { Icon: X, color: "text-th-error", label: "failed" },
	interrupted: { Icon: Ban, color: "text-th-text-muted", label: "interrupted" },
};

// A spinner means still running, an icon means finished, its color says how it
// went — so the row states its status in exactly one place.
function TaskStatusIcon({ status }: { status: TaskRunStatus }) {
	if (status === "running") {
		return (
			<Spinner
				variant="current"
				size="h-3 w-3"
				className="shrink-0"
				srText="Task running"
			/>
		);
	}
	const { Icon, color, label } = statusConfig[status];
	return <Icon className={`size-3 shrink-0 ${color}`} aria-label={label} />;
}

/**
 * One Claude Task (subagent) call, rendered where the turn spawned it. It
 * shows the state the reducer maintains and infers nothing of its own.
 */
function TaskItem({ task }: Props) {
	const [expanded, setExpanded] = useState(false);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const hasDetail = Boolean(task.result || task.prompt);
	const failed = task.status === "failed";
	// A failure has to be read, but only pries the strip open once — after that
	// the user's own choice to collapse it stands. A failure that came back with
	// nothing to read has nothing to open for.
	const autoExpandedRef = useRef(false);

	useEffect(() => {
		if (failed && hasDetail && !autoExpandedRef.current) {
			autoExpandedRef.current = true;
			setExpanded(true);
		}
	}, [failed, hasDetail]);

	return (
		<div
			className={`rounded bg-th-bg-secondary text-xs ${failed ? "border border-th-error/40" : ""}`}
		>
			<button
				type="button"
				onClick={() => hasDetail && setExpanded(!expanded)}
				aria-expanded={hasDetail ? expanded : undefined}
				className={`flex w-full items-center gap-1.5 rounded p-2 text-left ${hasDetail ? "hover:bg-th-overlay-hover" : ""}`}
			>
				{/* Same affordance the tool strips use: a chevron means there is
				    something under this row, a blank keeps the rows aligned. */}
				{hasDetail ? (
					<ChevronRight
						className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
					/>
				) : (
					<span className="size-3 shrink-0" />
				)}
				<Workflow className="size-3 shrink-0 text-th-accent" />
				<span className="shrink-0 text-th-accent">Task</span>
				{task.subagentType && (
					<span className="shrink-0 rounded bg-th-accent/20 px-1.5 py-0.5 text-th-accent">
						{task.subagentType}
					</span>
				)}
				<span
					className={`min-w-0 flex-1 truncate ${failed ? "text-th-error" : "text-th-text-muted"}`}
				>
					{task.description}
				</span>
				<TaskStatusIcon status={task.status} />
			</button>

			{/* No body at all when the Task has reported nothing yet, so a failure
			    that came back empty cannot leave a bare border behind. */}
			<CollapsibleBody expanded={hasDetail && expanded}>
				<div className="border-t border-th-border">
					{/* The note belongs to the report it qualifies, not to the row:
					    on a phone a fixed-width label there truncates the
					    description away to nothing. */}
					{task.resultAfterInterrupt && (
						<p className="px-2 pt-2 text-th-text-muted opacity-70">
							Returned after the turn was interrupted.
						</p>
					)}
					{task.result && (
						<ScrollableContent className="max-h-[60vh] overflow-auto p-2">
							<MarkdownContent content={task.result} />
						</ScrollableContent>
					)}
					{task.prompt && (
						<div className="border-t border-th-border">
							<button
								type="button"
								onClick={() => setPromptExpanded(!promptExpanded)}
								aria-expanded={promptExpanded}
								className="flex w-full items-center gap-1.5 p-2 text-left hover:bg-th-overlay-hover"
							>
								<ChevronRight
									className={`size-3 shrink-0 text-th-text-muted transition-transform ${promptExpanded ? "rotate-90" : ""}`}
								/>
								<span className="text-th-text-muted">Prompt</span>
							</button>
							<CollapsibleBody expanded={promptExpanded}>
								<ScrollableContent className="max-h-[40vh] overflow-auto p-2">
									<pre className="whitespace-pre-wrap text-th-text-muted">
										{task.prompt}
									</pre>
								</ScrollableContent>
							</CollapsibleBody>
						</div>
					)}
				</div>
			</CollapsibleBody>
		</div>
	);
}

export default TaskItem;
