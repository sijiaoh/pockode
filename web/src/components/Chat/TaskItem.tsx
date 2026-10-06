import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { collectPartsDeep } from "../../lib/partTree";
import {
	countSteps,
	type LatestChild,
	type StepsLine,
	subagentReport,
	subagentStepsLine,
	withoutEchoedReport,
} from "../../lib/subagentRun";
import { stepsLabel, toolRunText, toolSecondLine } from "../../lib/toolRun";
import { taskPrompt, toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { ContentPart, ToolRun } from "../../types/message";
import { ClampedContent, CollapsibleBody, MarkdownContent } from "../ui";
import { PartBlocks } from "./ToolList";
import { ToolOutcomeSections } from "./ToolOutcomeSections";
import { Detail, ToolMeta, ToolRow, ToolStatusGlyph } from "./ToolRow";
import { useUnfiledChildren } from "./unfiledChildrenContext";

interface Props {
	run: ToolRun;
	/**
	 * How many Processes this row sits inside: 0 for a subagent the main agent
	 * spawned, 1 for one that subagent spawned, and so on.
	 */
	depth?: number;
	/**
	 * Draws one child exactly as the main transcript draws a part, so a `Grep`
	 * reads the same whoever ran it. The renderer lives with the transcript's,
	 * which is why it is handed in rather than imported.
	 */
	renderChild: (part: ContentPart) => ReactNode;
}

/**
 * Indented levels: each costs 18px (`ml-2`, the rail, `pl-2`), and three still
 * leave a 360px phone's innermost rows room for a title and a detail. Deeper
 * levels keep the rail — its 2px is all they cost — and indent no further.
 */
const MAX_INDENTED_LEVELS = 3;

/**
 * A pending permission card is never drawn inside a Process: the Process is
 * closed by default, and a card in it would leave a session waiting on someone
 * who cannot see why. The outermost subagent row draws it instead.
 */
function isPendingCard(part: ContentPart): boolean {
	return part.type === "permission_request" && part.status === "pending";
}

/** The latest child, worded as its own row would word it — never red. */
function LatestChildLabel({ child }: { child: LatestChild }) {
	const workDir = useWSStore((state) => state.workDir);
	if (child.kind === "text") {
		return <span className="min-w-0 truncate">{child.text}</span>;
	}
	const summary = toolSummary(child.name, child.input, workDir);
	return (
		<>
			{/* Secondary rather than the accent the row's own title wears: two
			    accent titles on one row would make the child read as the row. */}
			<span className="shrink-0 text-th-text-secondary">
				{summary.chip ? `${summary.title} ${summary.chip}` : summary.title}
			</span>
			<Detail
				detail={summary.detail}
				detailTail={summary.detailTail}
				mono={summary.mono}
			/>
		</>
	);
}

/**
 * `N steps · <latest child>`. The count never yields width: on a narrow phone
 * the latest child is cut to a few characters and the count — the half that
 * answers "is it moving" — is still there.
 */
function StepsLineContent({ line }: { line: StepsLine }) {
	return (
		<>
			<span className="shrink-0">{stepsLabel(line.steps)}</span>
			{line.tail && (
				<>
					<span className="shrink-0">·</span>
					<LatestChildLabel child={line.tail} />
				</>
			)}
		</>
	);
}

/**
 * What an empty body says, which depends on why it is empty. A subagent that
 * failed or was cut short reported nothing either, and telling the reader it
 * "is still working" is the same lie the spinner used to tell — the row above
 * has already settled.
 *
 * A settled backgrounded subagent gets its own sentence, because the others
 * would all put the silence down to the subagent: its call returned a
 * placeholder, and how it ended is the outcome under its own label below.
 */
function emptyReport(run: ToolRun, hasOutcome: boolean): string {
	// Only with an outcome to point at: one backgrounded and then cut short
	// before it reported has none, and the status sentences below say why.
	if (run.fromBackground && run.status !== "background" && hasOutcome) {
		return "The subagent ran in the background; how it ended is under Outcome below.";
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
 *
 * What the subagent itself said and did is filed under the row as its
 * children, and drawn behind a Process disclosure that nothing but the user
 * opens (docs/tool-call-ui.md#a-subagents-own-work).
 */
function TaskItem({ run, depth = 0, renderChild }: Props) {
	const [expanded, setExpanded] = useState(false);
	const [processExpanded, setProcessExpanded] = useState(false);
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
	const report = run.fromBackground ? "" : subagentReport(text);
	const failed = run.status === "error";
	const nested = depth > 0;

	const children = run.children ?? [];
	const unfiled = useUnfiledChildren(run.id);
	const steps = countSteps(children) + (unfiled?.steps ?? 0);
	const stepsLine = subagentStepsLine(run, unfiled);
	// The report — or a backgrounded subagent's outcome, which is its last
	// words delivered after the call returned (Claude's notification summary,
	// measured on claude 2.1.286) — is drawn in full above the Process, and
	// not again at its end.
	const shownChildren = withoutEchoedReport(children, report || outcome)
		.map((part, index) => ({ part, index }))
		.filter(({ part }) => !isPendingCard(part));
	const hasProcess = shownChildren.length > 0 || (unfiled?.count ?? 0) > 0;
	// Cards from every depth, so a subagent's subagent asking is not hidden
	// under a row that is itself inside a closed Process. Only the outermost
	// row collects them: it is the one the user can always see.
	const pendingCards = nested ? [] : collectPartsDeep(children, isPendingCard);
	const processLabel = summary.chip
		? `${summary.chip} subagent's process`
		: "Subagent's process";
	const level = depth + 1;

	// A failure has to be read, but only pries the body open once — after that
	// the user's own choice to collapse it stands.
	//
	// Kept here after the tool row dropped it, because the two are not the same
	// case: a tool call failing is ordinary trial and error and its output is one
	// line away on the row, while a subagent failing is rare and its report — the
	// only account of what went wrong — exists nowhere but this body.
	//
	// Not inside a Process: there the row is mid-transcript by definition, and
	// the outer subagent has already dealt with the failure — its red row says
	// so, and the outer report is the account.
	const autoExpandedRef = useRef(false);

	useEffect(() => {
		if (failed && !nested && !autoExpandedRef.current) {
			autoExpandedRef.current = true;
			setExpanded(true);
		}
	}, [failed, nested]);

	return (
		<div className="text-xs">
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={<ToolStatusGlyph status={run.status} name="Task" />}
				title={summary.title}
				chip={summary.chip}
				background={run.fromBackground}
				detail={summary.detail}
				meta={<ToolMeta run={run} />}
				// With steps the row has its own line, which copies nothing in the
				// body. Without, the shared one stands — except that it ends a failed
				// run with the last line of its text, and here that text is the
				// report, which this row has already opened in full below: a worse
				// second copy, in mono because the shared rule expects machine
				// output. A backgrounded failure keeps it, being the one failed row
				// whose body does not open.
				richSecondLine={
					stepsLine && {
						content: <StepsLineContent line={stepsLine} />,
						live: stepsLine.live,
					}
				}
				secondLine={
					stepsLine || (failed && !run.fromBackground)
						? null
						: toolSecondLine(run)
				}
				error={failed}
			/>

			{pendingCards.length > 0 && (
				// Between the row and its body, outside the collapsible: visible
				// whether the row is open or not, and inside this item's DOM, which
				// is what tells a screen reader whose request it is.
				<div className="px-2 pb-2">
					<PartBlocks
						items={pendingCards.map((part, index) => ({ part, index }))}
						renderPart={({ part }) => renderChild(part)}
					/>
				</div>
			)}

			<CollapsibleBody expanded={expanded}>
				<div className="row-ground-secondary border-t border-th-border bg-th-bg-secondary">
					{/* The note belongs to the report it qualifies, not to the row:
					    on a phone a fixed-width label there truncates the
					    description away to nothing. */}
					{run.status === "interrupted" && report && (
						<p className="px-2 pt-2 text-th-text-muted">
							Returned after the turn was interrupted.
						</p>
					)}
					{report ? (
						<div className="p-2">
							<ClampedContent>
								<MarkdownContent content={report} />
							</ClampedContent>
						</div>
					) : (
						// A backgrounded subagent's outcome below is its report, and
						// says so in its own label; a sentence about it would only
						// stand between the reader and it.
						!(outcome && !failed) && (
							<p className="p-2 text-th-text-muted">
								{emptyReport(run, outcome !== "")}
							</p>
						)
					)}
					{/* After the report, before the prompt: the report is the
					    subagent's conclusion, and what a later call fetched of its raw
					    output is evidence for it. */}
					<ToolOutcomeSections
						run={run}
						outcome={outcome && <MarkdownContent content={outcome} />}
						block
					/>
					{hasProcess && (
						<div className="border-t border-th-border">
							<button
								type="button"
								onClick={() => setProcessExpanded(!processExpanded)}
								aria-expanded={processExpanded}
								className="flex w-full items-center gap-1.5 p-2 text-left hover:bg-th-overlay-hover"
							>
								<ChevronRight
									className={`size-3 shrink-0 text-th-text-muted transition-transform ${processExpanded ? "rotate-90" : ""}`}
								/>
								<span className="text-th-text-muted">
									{steps > 0 ? `Process · ${stepsLabel(steps)}` : "Process"}
								</span>
							</button>
							<CollapsibleBody expanded={processExpanded}>
								{/* Neither clamped nor scrolling: the rows inside open into
								    bodies of their own, which a clamp would hide behind a
								    "Show all", and a scroller in the transcript is a drag
								    that goes to whichever box is under the thumb. */}
								<div className="pb-2">
									{/* biome-ignore lint/a11y/useSemanticElements: a column of transcript parts, not form controls a fieldset would group */}
									<div
										role="group"
										aria-label={processLabel}
										// Its own right margin: the lists in it have frames, and one
										// flush with the frame of the list this row sits in would
										// draw the two as a single doubled line.
										className={`space-y-2 border-l-2 border-th-border py-2 pr-2 ${level <= MAX_INDENTED_LEVELS ? "ml-2 pl-2" : ""}`}
									>
										<PartBlocks
											items={shownChildren}
											renderPart={({ part }) => renderChild(part)}
										/>
										{unfiled && unfiled.count > 0 && (
											<p className="text-th-text-muted">
												{unfiled.count === 1
													? "1 more from this subagent is further down, where it first loaded."
													: `${unfiled.count} more from this subagent are further down, where they first loaded.`}
											</p>
										)}
									</div>
								</div>
							</CollapsibleBody>
						</div>
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
								<div className="p-2">
									<ClampedContent>
										<pre className="whitespace-pre-wrap text-th-text-muted">
											{prompt}
										</pre>
									</ClampedContent>
								</div>
							</CollapsibleBody>
						</div>
					)}
				</div>
			</CollapsibleBody>
		</div>
	);
}

export default TaskItem;
