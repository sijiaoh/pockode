import { Fragment, useMemo } from "react";
import type { FullScreenSource } from "../../lib/fullScreen";
import {
	isLiveRun,
	settledTokens,
	subagentLastWords,
} from "../../lib/subagentRun";
import { toolRunLook } from "../../lib/toolRun";
import {
	subagentType,
	toolSummary,
	toolSummaryLine,
} from "../../lib/toolSummary";
import type { ToolRun } from "../../types/message";
import { formatTokens } from "../../utils/tokens";
import { MarkdownContent } from "../ui";
import { HeaderlessMainBlock } from "./HeaderlessMainBlock";
import { ToolOutcomeSections } from "./ToolOutcomeSections";
import { useTranscriptView } from "./transcriptViewContext";

/**
 * What the row leaves out, for the reader who needs to quote it back: the
 * subagent's id, which resuming it takes, and its full type where the title
 * shortened it — or where only the result named it — and its tokens, which a
 * narrow row drops first.
 */
export function FactsLine({ run }: { run: ToolRun }) {
	const title = toolSummary(run.name, run.input, "").title;
	const type = subagentType(run.input) ?? run.subagent?.agentType;
	const agentId = run.subagent?.agentId;
	const tokens = settledTokens(run);
	const facts = [
		type !== undefined && type !== title && type,
		agentId && (
			<>
				agent <span className="break-all font-mono">{agentId}</span>
			</>
		),
		tokens !== undefined && `${formatTokens(tokens)} tokens`,
	].filter((fact) => fact !== false && fact !== undefined && fact !== "");
	if (facts.length === 0) return null;
	return (
		<p className="border-t border-th-border p-2 text-th-text-muted">
			{facts.map((fact, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed order of at most three facts
				<Fragment key={i}>
					{i > 0 && " · "}
					{fact}
				</Fragment>
			))}
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
	if (toolRunLook(run) === "denied") {
		return "The call was denied, so the subagent never started.";
	}
	switch (run.status) {
		case "running":
		case "background":
			return "No report yet — the subagent is still working.";
		case "interrupted":
			if (run.finishedAfterStop) {
				return "The subagent finished after the turn was stopped, without reporting anything.";
			}
			return run.lostWithProcess
				? "The CLI process ended before the subagent reported anything."
				: "The turn was interrupted before the subagent reported anything.";
		case "error":
			return "The subagent failed without reporting anything.";
		default:
			return "The subagent finished without reporting anything.";
	}
}

interface Props {
	run: ToolRun;
	/**
	 * Drawn at the end of the subagent's own transcript rather than in its
	 * row's body: the report is labelled, since it no longer opens the box it
	 * is in, and a live subagent says nothing — the header's spinner already
	 * does (docs/subagent-transcript-ui.md#what-a-level-shows).
	 */
	inTranscript?: boolean;
}

/**
 * How a subagent ended: the interrupted note, its report or why there is
 * none, and the outcome sections. One component for the row's body and the
 * subagent's transcript, so the two cannot drift apart.
 */
export function SubagentConclusion({ run, inTranscript = false }: Props) {
	const view = useTranscriptView();
	const { report, outcome } = subagentLastWords(run);
	const failed = toolRunLook(run) === "error";
	const fullScreenTitle = toolSummaryLine(toolSummary(run.name, run.input, ""));
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
	// A backgrounded subagent's outcome below is its report, and says so in
	// its own label; a sentence about it would only stand between the reader
	// and it.
	const saysEmpty =
		!report && !(outcome && !failed) && !(inTranscript && isLiveRun(run));

	return (
		<>
			{/* The note belongs to the report it qualifies, not to the row: on a
			    phone a fixed-width label there truncates the description away
			    to nothing. */}
			{run.status === "interrupted" && report && (
				<p className="px-2 pt-2 text-th-text-muted">
					{run.finishedAfterStop
						? "Finished after the turn was stopped."
						: "Returned after the turn was interrupted."}
				</p>
			)}
			{report && (
				<div className="p-2">
					{inTranscript && <p className="pb-1 text-th-text-muted">Report</p>}
					<HeaderlessMainBlock
						name="report"
						fullScreenKey={`report:${run.id}`}
						source={reportSource}
						view={view}
					>
						<MarkdownContent content={report} />
					</HeaderlessMainBlock>
				</div>
			)}
			{saysEmpty && (
				<p className="p-2 text-th-text-muted">
					{emptyReport(run, outcome !== "")}
				</p>
			)}
			{/* After the report: the report is the subagent's conclusion, and what
			    a later call fetched of its raw output is evidence for it. */}
			<ToolOutcomeSections
				run={run}
				outcome={outcome && <MarkdownContent content={outcome} />}
				outcomeFullScreen={outcomeFullScreen}
				block
			/>
		</>
	);
}
