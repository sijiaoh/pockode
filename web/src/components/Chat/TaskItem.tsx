import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { FullScreenSource } from "../../lib/fullScreen";
import { collectPartsWithin } from "../../lib/partTree";
import {
	countSteps,
	type LatestChild,
	resumedRun,
	type SubagentLine,
	subagentLine,
	subagentReport,
	withoutEchoedReport,
} from "../../lib/subagentRun";
import { toolRunText, toolSecondLine, toolUsesLabel } from "../../lib/toolRun";
import {
	SUBAGENT_TITLE,
	subagentType,
	taskPrompt,
	toolSummary,
	toolSummaryLine,
} from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { ContentPart, ToolRun } from "../../types/message";
import { formatTokens } from "../../utils/tokens";
import { ClampedContent, CollapsibleBody, MarkdownContent } from "../ui";
import { HeaderlessMainBlock } from "./HeaderlessMainBlock";
import { useSubagentResume } from "./subagentResumesContext";
import { PartBlocks } from "./ToolList";
import { ToolOutcomeSections } from "./ToolOutcomeSections";
import {
	AgentTitle,
	Detail,
	RowSubline,
	ToolMeta,
	ToolRow,
	ToolStatusGlyph,
} from "./ToolRow";
import { useTranscriptView } from "./transcriptViewContext";
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
	 * which is why it is handed in rather than imported. `asker` is a pending
	 * card's asker line, for one a nested subagent asked.
	 */
	renderChild: (part: ContentPart, asker?: ReactNode) => ReactNode;
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

/**
 * Which subagent asked, on a card from deeper down than the row it is drawn
 * under: named as that subagent's own row names it, but in the secondary
 * colour — an accent title over the card's own would make two rows of one card
 * (docs/tool-call-ui.md#when-a-step-asks-the-user).
 */
function AskerLine({ asker }: { asker: ToolRun }) {
	const summary = toolSummary(asker.name, asker.input, "");
	return (
		<RowSubline above>
			<span className="flex min-w-0 items-baseline gap-1.5">
				<AgentTitle
					title={summary.title}
					spoken="Asked by "
					className="text-th-text-secondary"
				/>
				<Detail
					detail={summary.detail}
					detailTail={summary.detailTail}
					mono={summary.mono}
				/>
			</span>
		</RowSubline>
	);
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
 * `N tool uses · <latest child>`, or once settled the figures. The count never
 * yields width: on a narrow phone the latest child is cut to a few characters
 * and the count — the half that answers "is it moving" — is still there.
 */
function SubagentLineContent({ line }: { line: SubagentLine }) {
	const count = line.toolUses > 0 && (
		<span className="shrink-0">{toolUsesLabel(line.toolUses)}</span>
	);
	if (line.tokens !== undefined) {
		// One line that wraps into its own hidden overflow, so a figure that
		// does not fit drops out whole rather than reading `45.`.
		return (
			<span className="flex h-[1lh] min-w-0 flex-wrap items-baseline gap-x-1.5 overflow-hidden">
				{count}
				<span className="flex shrink-0 gap-1.5">
					{count && <span>·</span>}
					<span>{formatTokens(line.tokens)} tokens</span>
				</span>
			</span>
		);
	}
	return (
		<>
			{count}
			{line.tail && (
				<>
					{count && <span className="shrink-0">·</span>}
					<LatestChildLabel child={line.tail} />
				</>
			)}
		</>
	);
}

/**
 * What the row leaves out, for the reader who needs to quote it back: the
 * subagent's id, which resuming it takes, and its full type where the title
 * shortened it — or where only the result named it.
 */
function FactsLine({ run, title }: { run: ToolRun; title: string }) {
	const type = subagentType(run.input) ?? run.subagent?.agentType;
	const agentId = run.subagent?.agentId;
	const showType = type !== undefined && type !== title;
	if (!showType && !agentId) return null;
	return (
		<p className="border-t border-th-border p-2 text-th-text-muted">
			{showType && type}
			{showType && agentId && " · "}
			{agentId && (
				<>
					agent <span className="break-all font-mono">{agentId}</span>
				</>
			)}
		</p>
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
			return run.lostWithProcess
				? "The CLI process ended before the subagent reported anything."
				: "The turn was interrupted before the subagent reported anything.";
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
 * opens — as is the body itself, failed or not: a failure says why on the row
 * (docs/tool-call-ui.md#a-subagents-own-work).
 */
function TaskItem({ run, depth = 0, renderChild }: Props) {
	const [expanded, setExpanded] = useState(false);
	const [processExpanded, setProcessExpanded] = useState(false);
	const [promptExpanded, setPromptExpanded] = useState(false);
	const view = useTranscriptView();
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
	const fullScreenTitle = toolSummaryLine(summary);
	const reportSource = useMemo<FullScreenSource | undefined>(
		() =>
			report
				? {
						title: fullScreenTitle,
						label: "Report",
						noun: "report",
						from: "start",
						copyText: report,
						content: { kind: "markdown", markdown: report },
					}
				: undefined,
		[report, fullScreenTitle],
	);
	const reportKey = `report:${run.id}`;
	const outcomeFullScreen = useMemo(
		() =>
			outcome
				? {
						key: `${run.id}:result`,
						title: fullScreenTitle,
						content: { kind: "markdown" as const, markdown: outcome },
					}
				: undefined,
		[outcome, run.id, fullScreenTitle],
	);

	const children = run.children ?? [];
	const unfiled = useUnfiledChildren(run.id);
	const steps = countSteps(children) + (unfiled?.steps ?? 0);
	// The row says what the subagent is doing now, which a resumed one is
	// doing under the call that resumed it; the body keeps what it reported.
	const resume = useSubagentResume(run.id);
	const rowRun = resume ? resumedRun(run, resume) : run;
	const line = subagentLine(rowRun, unfiled);
	// The report — or a backgrounded subagent's outcome, which is its last
	// words delivered after the call returned (Claude's notification summary,
	// measured on claude 2.1.286) — is drawn in full above the Process, and
	// not again at its end.
	const shownChildren = withoutEchoedReport(children, report || outcome)
		.filter((part) => !isPendingCard(part))
		.map((part) => ({ part }));
	const hasProcess = shownChildren.length > 0 || (unfiled?.count ?? 0) > 0;
	// Cards from every depth, so a subagent's subagent asking is not hidden
	// under a row that is itself inside a closed Process. Only the outermost
	// row collects them: it is the one the user can always see. The innermost
	// subagent a card was found in is the one that asked.
	const pendingCards = nested
		? []
		: collectPartsWithin(children, isPendingCard).map(({ part, within }) => ({
				part,
				asker: within.at(-1),
			}));
	const processLabel =
		summary.title === SUBAGENT_TITLE
			? "Subagent's process"
			: `${summary.title} subagent's process`;
	const level = depth + 1;

	return (
		<div className="text-xs">
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={<ToolStatusGlyph status={rowRun.status} name={SUBAGENT_TITLE} />}
				title={summary.title}
				agent
				background={run.fromBackground}
				detail={summary.detail}
				meta={<ToolMeta run={rowRun} />}
				// Its own line where it has one; the shared one stands otherwise.
				richSecondLine={
					line && {
						content: <SubagentLineContent line={line} />,
						live: line.live,
					}
				}
				secondLine={line ? null : toolSecondLine(rowRun)}
				error={rowRun.status === "error"}
			/>

			{pendingCards.length > 0 && (
				// Between the row and its body, outside the collapsible: visible
				// whether the row is open or not.
				<div className="px-2 pb-2">
					<PartBlocks
						items={pendingCards}
						renderPart={({ part, asker }) =>
							renderChild(part, asker && <AskerLine asker={asker} />)
						}
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
							<HeaderlessMainBlock
								name="report"
								fullScreenKey={reportKey}
								source={reportSource}
								view={view}
							>
								<MarkdownContent content={report} />
							</HeaderlessMainBlock>
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
						outcomeFullScreen={outcomeFullScreen}
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
									{steps > 0 ? `Process · ${toolUsesLabel(steps)}` : "Process"}
								</span>
							</button>
							<CollapsibleBody expanded={processExpanded}>
								{/* Neither clamped nor scrolling: the rows inside open into
								    bodies of their own, which a clamp would hide behind a
								    "Show N more", and a scroller in the transcript is a drag
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
									<ClampedContent name="prompt" view={view}>
										<MarkdownContent content={prompt} variant="note" />
									</ClampedContent>
								</div>
							</CollapsibleBody>
						</div>
					)}
					<FactsLine run={run} title={summary.title} />
				</div>
			</CollapsibleBody>
		</div>
	);
}

export default TaskItem;
