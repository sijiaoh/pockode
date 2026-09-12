import { Ban, Check, ChevronRight, Workflow, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TaskRun, TaskRunStatus } from "../../types/message";
import { CollapsibleBody, ScrollableContent, Spinner } from "../ui";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
	tasks: TaskRun[];
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

/** Everything the collapsed header has to say, read straight off the tasks. */
function summarize(tasks: TaskRun[]): string {
	if (tasks.length === 1) return tasks[0].description;

	const count = (status: TaskRunStatus) =>
		tasks.filter((task) => task.status === status).length;
	const done = count("done");
	const failed = count("failed");
	const interrupted = count("interrupted");

	let summary =
		done === tasks.length
			? `${tasks.length} subtasks · all done`
			: `${done}/${tasks.length} done`;
	if (failed > 0) summary += ` · ${failed} failed`;
	if (interrupted > 0) summary += ` · ${interrupted} interrupted`;
	return summary;
}

function TaskStatusIcon({ status }: { status: TaskRunStatus }) {
	if (status === "running") {
		return (
			<Spinner
				variant="current"
				size="h-3 w-3"
				className="shrink-0"
				srText="running"
			/>
		);
	}
	const { Icon, color, label } = statusConfig[status];
	return <Icon className={`size-3 shrink-0 ${color}`} aria-label={label} />;
}

interface TaskRowProps {
	task: TaskRun;
	index: number;
}

function TaskRow({ task, index }: TaskRowProps) {
	const [expanded, setExpanded] = useState(false);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const hasDetail = Boolean(task.result || task.prompt);

	return (
		<div className={index > 0 ? "border-t border-th-border" : ""}>
			<button
				type="button"
				onClick={() => hasDetail && setExpanded(!expanded)}
				aria-expanded={hasDetail ? expanded : undefined}
				className={`flex w-full items-center gap-1.5 p-2 text-left ${hasDetail ? "hover:bg-th-overlay-hover" : ""}`}
			>
				<TaskStatusIcon status={task.status} />
				<span className="shrink-0 text-th-text-muted">{index + 1}</span>
				{task.subagentType && (
					<span className="shrink-0 rounded bg-th-accent/20 px-1.5 py-0.5 text-th-accent">
						{task.subagentType}
					</span>
				)}
				<span
					className={`min-w-0 flex-1 truncate ${task.status === "failed" ? "text-th-error" : "text-th-text-muted"}`}
				>
					{task.description}
				</span>
				{/* Same affordance the tool strips use: a chevron means there is
				    something under this row, a blank keeps the rows aligned. */}
				{hasDetail ? (
					<ChevronRight
						className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
					/>
				) : (
					<span className="size-3 shrink-0" />
				)}
			</button>

			<CollapsibleBody expanded={expanded}>
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

/**
 * One turn's subagent calls as a single collapsed strip. It renders the state
 * the reducer maintains and infers nothing of its own.
 */
function TaskGroupItem({ tasks }: Props) {
	const [expanded, setExpanded] = useState(false);
	// A failure has to be seen, but only pries the strip open once — after that
	// the user's own choice to collapse it stands.
	const autoExpandedRef = useRef(false);
	const hasFailure = tasks.some((task) => task.status === "failed");
	const hasRunning = tasks.some((task) => task.status === "running");

	useEffect(() => {
		if (hasFailure && !autoExpandedRef.current) {
			autoExpandedRef.current = true;
			setExpanded(true);
		}
	}, [hasFailure]);

	return (
		<div
			className={`rounded bg-th-bg-secondary text-xs ${hasFailure ? "border border-th-error/40" : ""}`}
		>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<Workflow className="size-3 shrink-0 text-th-accent" />
				<span className="shrink-0 text-th-accent">Task</span>
				{/* The multi-Task summary says how it went in words; a lone one
				    shows only its description, so it needs the icon. */}
				{tasks.length === 1 && tasks[0].status !== "running" && (
					<TaskStatusIcon status={tasks[0].status} />
				)}
				<span className="min-w-0 truncate text-th-text-muted">
					{summarize(tasks)}
				</span>
				{hasRunning && (
					<Spinner
						variant="current"
						size="h-3 w-3"
						className="ml-auto shrink-0"
						srText="Task running"
					/>
				)}
			</button>

			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border">
					{tasks.map((task, index) => (
						<TaskRow key={task.toolUseId} task={task} index={index} />
					))}
				</div>
			</CollapsibleBody>
		</div>
	);
}

export default TaskGroupItem;
