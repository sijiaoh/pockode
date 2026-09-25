import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toolRunText, toolSecondLine } from "../../lib/toolRun";
import { taskPrompt, toolSummary } from "../../lib/toolSummary";
import type { ToolRun } from "../../types/message";
import { CollapsibleBody, MarkdownContent, ScrollableContent } from "../ui";
import { ToolOutcomeSections } from "./ToolOutcomeSections";
import { ToolMeta, ToolRow, ToolStatusGlyph } from "./ToolRow";

interface Props {
	run: ToolRun;
}

/**
 * What an empty body says, which depends on why it is empty. A subagent that
 * failed or was cut short reported nothing either, and telling the reader it
 * "is still working" is the same lie the spinner used to tell — the row above
 * has already settled.
 *
 * A settled backgrounded subagent gets its own sentence, because the others
 * would all put the silence down to the subagent: its report never comes back
 * here once the call has handed a placeholder to the agent, and what did arrive
 * is the outcome under its own label below.
 */
function emptyReport(run: ToolRun): string {
	if (run.fromBackground && run.status !== "background") {
		return "A backgrounded subagent's own report does not come back to the transcript.";
	}
	switch (run.status) {
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
	// A backgrounded Task's text is not its report: the subagent's own account
	// never reached this client, and what did arrive is the notification that
	// said how it ended. Drawing that as the report — which is what this body
	// used to do — asserts the agent read something it never did, so it goes
	// under its own label below instead.
	const text = toolRunText(run);
	const outcome = run.fromBackground ? text : "";
	const report = run.fromBackground ? "" : text;
	const failed = run.status === "error";
	// A failure has to be read, but only pries the body open once — after that
	// the user's own choice to collapse it stands.
	//
	// Kept here after the tool row dropped it, because the two are not the same
	// case: a tool call failing is ordinary trial and error and its output is one
	// line away on the row, while a subagent failing is rare and its report — the
	// only account of what went wrong — exists nowhere but this body.
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
				// The shared second line ends a failed run with the last line of its
				// text; here that text is the report, which this row has already
				// opened in full below — so the line would be a worse second copy of
				// something already on screen, drawn in mono because the shared rule
				// expects machine output rather than markdown.
				secondLine={failed ? null : toolSecondLine(run)}
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
						<p className="p-2 text-th-text-muted">{emptyReport(run)}</p>
					)}
					{/* After the report, before the prompt: the report is the
					    subagent's conclusion, and what a later call fetched of its raw
					    output is evidence for it. */}
					<ToolOutcomeSections
						run={run}
						outcome={outcome && <MarkdownContent content={outcome} />}
						block
					/>
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
