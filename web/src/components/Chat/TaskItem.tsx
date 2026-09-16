import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toolRunText, toolSecondLine } from "../../lib/toolRun";
import { taskPrompt, toolSummary } from "../../lib/toolSummary";
import type { ToolRun, ToolRunStatus } from "../../types/message";
import { CollapsibleBody, ScrollableContent } from "../ui";
import { MarkdownContent } from "./MarkdownContent";
import { ToolMeta, ToolRow, ToolStatusGlyph } from "./ToolRow";

interface Props {
	run: ToolRun;
}

/**
 * What an empty body says, which depends on why it is empty. A subagent that
 * failed or was cut short reported nothing either, and telling the reader it
 * "is still working" is the same lie the spinner used to tell — the row above
 * has already settled.
 */
function emptyReport(status: ToolRunStatus): string {
	switch (status) {
		case "running":
		case "background":
			return "No report yet — the subagent is still working.";
		case "interrupted":
			return "The turn was interrupted before the subagent reported anything.";
		case "error":
			return "The subagent failed without reporting anything.";
		default:
			return "The subagent finished without reporting anything.";
	}
}

/**
 * One subagent call, rendered where the turn spawned it.
 *
 * A subagent call *is* a tool call — it is a `ToolRun` like every other row,
 * and the reducer maintains its state — so this is a renderer for that
 * category and not a second model: the row grammar, the glyphs and the second
 * line all come from the shared row.
 */
function TaskItem({ run }: Props) {
	const [expanded, setExpanded] = useState(false);
	const [promptExpanded, setPromptExpanded] = useState(false);
	// No work directory: a subagent call is summarised from its description, and
	// there is no path in it for one to shorten.
	const summary = toolSummary(run.name, run.input, "");
	const prompt = taskPrompt(run.input);
	const report = toolRunText(run);
	const failed = run.status === "error";
	// A failure has to be read, but only pries the body open once — after that
	// the user's own choice to collapse it stands.
	const autoExpandedRef = useRef(false);

	useEffect(() => {
		if (failed && !autoExpandedRef.current) {
			autoExpandedRef.current = true;
			setExpanded(true);
		}
	}, [failed]);

	return (
		<div
			className={`rounded bg-th-bg-secondary text-xs ${failed ? "border border-th-error/40" : ""}`}
		>
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={<ToolStatusGlyph status={run.status} name="Task" />}
				title={summary.title}
				chip={summary.chip}
				background={run.fromBackground}
				detail={summary.detail}
				meta={<ToolMeta run={run} />}
				secondLine={toolSecondLine(run)}
				error={failed}
			/>

			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border">
					{/* The note belongs to the report it qualifies, not to the row:
					    on a phone a fixed-width label there truncates the
					    description away to nothing. */}
					{run.status === "interrupted" && report && (
						<p className="px-2 pt-2 text-th-text-muted">
							Returned after the turn was interrupted.
						</p>
					)}
					{report ? (
						<ScrollableContent className="max-h-[60vh] overflow-auto p-2">
							<MarkdownContent content={report} />
						</ScrollableContent>
					) : (
						<p className="p-2 text-th-text-muted">{emptyReport(run.status)}</p>
					)}
					{prompt && (
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
										{prompt}
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
