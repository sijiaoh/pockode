import { ChevronRight, Maximize2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { collectPartsWithin, findToolRunPath } from "../../lib/partTree";
import {
	countSteps,
	hasProcess,
	isLiveRun,
	isPendingCard,
	type LatestChild,
	processChildren,
	recentSteps,
	resumedRun,
	type SubagentLine,
	subagentLine,
	type UnfiledChildren,
} from "../../lib/subagentRun";
import { toolSecondLine, toolUsesLabel } from "../../lib/toolRun";
import {
	SUBAGENT_TITLE,
	subagentPossessive,
	taskPrompt,
	toolSummary,
} from "../../lib/toolSummary";
import type { ContentPart, ToolRun } from "../../types/message";
import { formatTokens } from "../../utils/tokens";
import {
	ClampedContent,
	CollapsibleBody,
	headerButtonClass,
	MarkdownContent,
} from "../ui";
import { FactsLine, SubagentConclusion } from "./SubagentConclusion";
import { StepCallLabel, SubagentStepWindow } from "./SubagentStepWindow";
import { useStepWindowLines } from "./stepWindowContext";
import { useSubagentResume } from "./subagentResumesContext";
import {
	SUBAGENT_OPENER_ATTR,
	useOpenSubagentTranscript,
} from "./subagentTranscriptContext";
import { PartBlocks } from "./ToolList";
import {
	AgentTitle,
	Detail,
	RowSubline,
	ToolMeta,
	ToolRow,
	ToolStatusGlyph,
} from "./ToolRow";
import { useRevealRequest } from "./toolJumpContext";
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
export function LatestChildLabel({ child }: { child: LatestChild }) {
	if (child.kind === "text") {
		return <span className="min-w-0 truncate">{child.text}</span>;
	}
	return <StepCallLabel name={child.name} input={child.input} />;
}

/**
 * `N tool uses · <latest child>`, or once settled the figures. The count never
 * yields width: on a narrow phone the latest child is cut to a few characters
 * and the count — the half that answers "is it moving" — is still there.
 */
export function SubagentLineContent({ line }: { line: SubagentLine }) {
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
 * A subagent row's first and second line, as `ToolRow` takes them. The row and
 * an entry in the agents list both draw from this
 * (docs/turn-progress-ui.md#43-the-agents-line), so they cannot say different
 * things about one run. `rowRun` is the run as its row draws it — a resumed
 * subagent's on its resume (`resumedRun`); `stepWindow` is the row's step
 * window, when it draws one.
 */
export function subagentHeader(
	rowRun: ToolRun,
	unfiled?: UnfiledChildren,
	stepWindow?: ReactNode,
) {
	// No work directory: a subagent call is summarised from its description, and
	// there is no path in it for one to shorten.
	const summary = toolSummary(rowRun.name, rowRun.input, "");
	const line = subagentLine(rowRun, unfiled, stepWindow !== undefined);
	const failed = rowRun.status === "error";
	return {
		summary,
		failed,
		glyph: <ToolStatusGlyph status={rowRun.status} name={SUBAGENT_TITLE} />,
		firstLine: {
			title: summary.title,
			agent: true,
			background: rowRun.fromBackground,
			detail: summary.detail,
			meta: <ToolMeta run={rowRun} />,
			error: failed,
		},
		// Its own line where it has one; the shared one stands otherwise.
		secondLine: {
			richSecondLine: line && {
				content: <SubagentLineContent line={line} />,
				live: line.live,
				below: stepWindow,
			},
			secondLine: line ? null : toolSecondLine(rowRun),
		},
	};
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
	// A jump to one of the subagent's steps opens the row and its Process; the
	// lists inside open their groups themselves, at whatever depth.
	useRevealRequest((toolUseId) => {
		if (!findToolRunPath(run.children ?? [], toolUseId)) return;
		setExpanded(true);
		setProcessExpanded(true);
	});
	const prompt = taskPrompt(run.input);
	const nested = depth > 0;
	const openTranscript = useOpenSubagentTranscript();

	const children = run.children ?? [];
	const unfiled = useUnfiledChildren(run.id);
	const steps = countSteps(children) + (unfiled?.steps ?? 0);
	// The row says what the subagent is doing now, which a resumed one is
	// doing under the call that resumed it; the body keeps what it reported.
	const resume = useSubagentResume(run.id);
	const rowRun = resume ? resumedRun(run, resume) : run;
	// The step window, by the list's rules, and not while the Process is open
	// inline: that shows the same steps whole
	// (docs/tool-call-ui.md#the-step-window).
	const windowLines = useStepWindowLines(rowRun);
	const windowSteps =
		expanded && processExpanded
			? []
			: recentSteps([...children, ...(unfiled?.parts ?? [])], windowLines);
	const header = subagentHeader(
		rowRun,
		unfiled,
		windowSteps.length > 0 ? (
			<SubagentStepWindow steps={windowSteps} frozen={!isLiveRun(rowRun)} />
		) : undefined,
	);
	const { summary } = header;
	// The report — or a backgrounded subagent's outcome, which is its last
	// words delivered after the call returned (Claude's notification summary,
	// measured on claude 2.1.286) — is drawn in full above the Process, and
	// not again at its end.
	const shownChildren = processChildren(run).map((part) => ({ part }));
	const showProcess = hasProcess(run, unfiled);
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
	const processLabel = `${subagentPossessive(summary.title)} process`;
	const transcriptLabel = `Open ${subagentPossessive(summary.title)} transcript`;
	const level = depth + 1;

	return (
		<div className="text-xs" data-tool-use-id={run.id}>
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={header.glyph}
				{...header.firstLine}
				{...header.secondLine}
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
					<SubagentConclusion run={run} />
					{showProcess && (
						<div className="border-t border-th-border">
							{/* Two buttons on one line, side by side rather than one
							    inside the other: the heading opens the Process inline,
							    the ⤢ opens it as a transcript of its own
							    (docs/subagent-transcript-ui.md#the-way-in). */}
							<div className="flex items-center">
								<button
									type="button"
									onClick={() => setProcessExpanded(!processExpanded)}
									aria-expanded={processExpanded}
									className="flex min-w-0 flex-1 items-center gap-1.5 p-2 text-left hover:bg-th-overlay-hover"
								>
									<ChevronRight
										className={`size-3 shrink-0 text-th-text-muted transition-transform ${processExpanded ? "rotate-90" : ""}`}
									/>
									<span className="text-th-text-muted">
										{steps > 0
											? `Process · ${toolUsesLabel(steps)}`
											: "Process"}
									</span>
								</button>
								{openTranscript && (
									<button
										type="button"
										onClick={(event) =>
											openTranscript(run.id, event.currentTarget)
										}
										aria-label={transcriptLabel}
										title={transcriptLabel}
										{...{ [SUBAGENT_OPENER_ATTR]: run.id }}
										className={`${headerButtonClass()} mr-1 shrink-0 hover:text-th-text-primary`}
									>
										<Maximize2 size={14} aria-hidden="true" />
									</button>
								)}
							</div>
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
					<FactsLine run={run} />
				</div>
			</CollapsibleBody>
		</div>
	);
}

export default TaskItem;
