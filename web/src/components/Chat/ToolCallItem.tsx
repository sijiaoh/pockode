import { memo, useMemo } from "react";
import { AGENT_CONTROL_TOOL, GENERATE_IMAGE_TOOL } from "../../lib/codexTools";
import {
	contentBlockFiles,
	contentBlocksText,
	type FileReference,
	partitionFileBlocks,
} from "../../lib/contentBlocks";
import {
	type FullScreenSubject,
	fullScreenSubject,
} from "../../lib/fullScreen";
import {
	pockodeWorkTool,
	workKindWord,
	workToolTarget,
} from "../../lib/pockodeWorkTools";
import {
	notebookCellLabel,
	notebookSource,
	proposedChange,
} from "../../lib/proposedChange";
import { isStopTool } from "../../lib/taskStop";
import { outputLineCount } from "../../lib/textLines";
import { toolBodyLayout } from "../../lib/toolBodyLayout";
import {
	lastOutputLines,
	shownResult,
	toolRunLook,
	toolSecondLine,
} from "../../lib/toolRun";
import { toolSummary, toolSummaryLine } from "../../lib/toolSummary";
import { notebookLines } from "../../lib/turnChanges";
import { useWSStore } from "../../lib/wsStore";
import type { ToolRun } from "../../types/message";
import { omittedLabel } from "../../utils/attachment";
import { CollapsibleBody, useEverExpanded } from "../ui";
import AttachmentStrip from "./AttachmentStrip";
import { GoToCallButton } from "./GoToCallButton";
import { useOpenWorkDetail } from "./openWorkDetailContext";
import {
	PermissionAnswerNote,
	readVerdict,
	VerdictLine,
} from "./PermissionAnswer";
import {
	changeFullScreenContent,
	LineCountsLabel,
	ProposedChange,
	proposedChangeHeader,
} from "./ProposedChange";
import { useRowExpanded } from "./rowExpansionContext";
import { useIsStopTargetLoaded } from "./stopTargetsContext";
import { PathLine, ToolInvocation } from "./ToolInvocation";
import { ToolOutcomeSections } from "./ToolOutcomeSections";
import ToolResultDisplay, {
	FAILURE_TEXT,
	resultCopyText,
	resultCount,
	resultFullScreenContent,
} from "./ToolResultDisplay";
import { ToolMeta, ToolRow, ToolStatusGlyph } from "./ToolRow";
import { Section, type SectionFullScreen } from "./ToolSection";
import { useGoToCall } from "./toolJumpContext";
import { WorkRefLine } from "./WorkRefLine";

/** How much of a running call's output the body shows. */
const LIVE_OUTPUT_LINES = 50;

interface Props {
	run: ToolRun;
	/** The session whose attachment store holds this call's file blocks. */
	sessionId: string;
	onOpenFile?: (path: string) => void;
}

/**
 * A file the result points at rather than contains: a background task's log,
 * named but deliberately never read.
 *
 * At the weight of a line of body text — no card, no border, no icon — because
 * it is a pointer and not an answer. The one that used to sit in the attachment
 * strip was a `w-56` card with a large glyph on every backgrounded row, and on
 * the common half of them, where the CLI wrote its log outside the work
 * directory, it had no button either: a card-shaped thing that could not be
 * tapped.
 *
 * Through `PathLine`, not the file name the block also carries: the line keeps
 * the name whole and cuts the directories first, so a second copy of the name
 * would only take a line.
 */
function ReferenceLine({
	file,
	onOpenFile,
}: {
	file: FileReference;
	onOpenFile?: (path: string) => void;
}) {
	const reason = omittedLabel(file);

	return (
		<div className="space-y-0.5">
			<PathLine path={file.path} onOpenFile={onOpenFile} />
			{reason && <p className="text-th-text-muted">{reason}</p>}
		</div>
	);
}

/**
 * The cell a `NotebookEdit` writes, read off its input as the permission card
 * and the turn's card read it, so it is there while the call runs too. Nothing
 * for an input not read as a cell: the invocation lists its arguments.
 */
function NotebookCellSection({
	run,
	title,
	subject,
	refused,
}: {
	run: ToolRun;
	title: string;
	subject: FullScreenSubject | undefined;
	/** The call failed or was denied, so the cell was not written. */
	refused: boolean;
}) {
	const change = proposedChange(run.name, run.input);
	const notebook = change?.kind === "notebook" ? change : null;
	// Green and red only once the call succeeded, and "not applied" only once
	// it failed or was denied: a call still running, or cut off, may or may
	// not have written the cell, so its counts are drawn plain.
	const settled = toolRunLook(run) === "success" || refused;
	const header = useMemo(
		() =>
			notebook && !settled
				? {
						meta: (
							<LineCountsLabel
								lines={notebookLines(notebook)}
								colored={false}
							/>
						),
					}
				: proposedChangeHeader(notebook, { applied: !refused }),
		[notebook, settled, refused],
	);
	const source = notebook ? notebookSource(notebook) : undefined;
	const fullScreen = useMemo<SectionFullScreen | undefined>(
		() =>
			notebook && source
				? {
						key: `${run.id}:cell`,
						title,
						subject,
						content: changeFullScreenContent(notebook),
					}
				: undefined,
		[notebook, source, run.id, title, subject],
	);
	if (!notebook) return null;
	return (
		<Section
			label={notebookCellLabel(notebook)}
			noun="cell"
			meta={header.meta}
			copyText={source || undefined}
			fullScreen={fullScreen}
			budget="main"
			count={
				source ? { noun: "line", total: outputLineCount(source) } : undefined
			}
		>
			<ProposedChange change={notebook} />
		</Section>
	);
}

/**
 * One tool call, as a row that opens into everything the row could not say.
 *
 * It renders the status the reducer maintains and infers nothing of its own
 * (docs/tool-call-ui.md).
 */
const ToolCallItem = memo(function ToolCallItem({
	run,
	sessionId,
	onOpenFile,
}: Props) {
	const [expanded, setExpanded] = useRowExpanded();
	const workDir = useWSStore((state) => state.workDir);
	const summary = useMemo(
		() => toolSummary(run.name, run.input, workDir, run.workRef),
		[run.name, run.input, workDir, run.workRef],
	);
	const openWorkDetail = useOpenWorkDetail();
	const look = toolRunLook(run);
	const succeeded = look === "success";
	const workTarget = useMemo(() => {
		const tool = pockodeWorkTool(run.name);
		return tool
			? workToolTarget(tool, run.input, run.workRef, succeeded)
			: null;
	}, [run.name, run.input, run.workRef, succeeded]);
	// Nothing opens this body but the user. A failure used to pry it open once,
	// back when a failed row said only *that* it failed; now it says how, on its
	// second line. Trial and error is how an agent works, so a turn with four
	// failed calls in it is ordinary — and four bodies unfolding themselves bury
	// the answer the user is actually reading.
	const failed = look === "error";
	// Failed or denied, the call did not do its work: a change it describes
	// was not applied, and what the engine said instead is the answer.
	const refused = failed || look === "denied";

	// Partitioned after `contentBlockFiles`, never before: that is where a lone
	// block borrows the Read's path, and a block with no path is not drawn as a
	// reference.
	const { attachments, references } = useMemo(
		() =>
			partitionFileBlocks(
				run.contents
					? contentBlockFiles(run.contents, {
							name: run.name,
							input: run.input,
						})
					: [],
			),
		[run.contents, run.name, run.input],
	);

	const live = run.status === "running" || run.status === "background";
	// A reviewer's or Pockode's answer keeps the line it had on the card.
	const verdict = run.permission
		? readVerdict(
				run.permission.answer,
				run.permission.by,
				run.permission.review,
			)
		: undefined;
	const liveOutput =
		live && run.output ? lastOutputLines(run.output, LIVE_OUTPUT_LINES) : "";
	const layout = toolBodyLayout(run.name);
	// What an image generation's result says besides its image: the prompt
	// Codex used. Without one there is no result to show in the body — the
	// image is the strip's.
	const generation = run.name === GENERATE_IMAGE_TOOL;
	const imagePrompt =
		generation && run.contents ? contentBlocksText(run.contents) : "";
	// A result that only acknowledges the call is no answer to show.
	const showsResult =
		Boolean(run.result || run.contents) &&
		!(layout.resultIsAcknowledgement && !refused) &&
		!(generation && !refused && !imagePrompt);
	// Eager rather than a function handed to the button, because whether there
	// is anything to copy decides whether there is a button. Gated on the body
	// having been opened: a collapsed `Read` should not pay to strip its line
	// numbers.
	const everExpanded = useEverExpanded(expanded);
	const result = shownResult(run.result ?? "");
	const copyText = useMemo(
		() =>
			everExpanded && showsResult
				? resultCopyText(run.name, run.input, result, run.contents)
				: undefined,
		[everExpanded, showsResult, run.name, run.input, result, run.contents],
	);
	// Gated the same way: diffing means reading the whole input. Mirrors when
	// `ToolResultDisplay` draws the change rather than content blocks. A
	// notebook's cell is a section of its own, beside the result rather than
	// in its place.
	const change = useMemo(() => {
		if (!everExpanded || !showsResult || run.contents) return null;
		const found = proposedChange(run.name, run.input);
		return found?.kind === "notebook" ? null : found;
	}, [everExpanded, showsResult, run.name, run.input, run.contents]);
	const changeHeader = useMemo(
		() => proposedChangeHeader(change, { applied: !refused }),
		[change, refused],
	);
	// A stop's way to the work it stopped, when that row is here to land on.
	// The jump leaves it as it is: that row says it was stopped through its own
	// outcome.
	const goToCall = useGoToCall();
	const stopTarget =
		isStopTool(run.name) && run.originToolUseId
			? run.originToolUseId
			: undefined;
	const stopTargetLoaded = useIsStopTargetLoaded(stopTarget);
	const outcomeActions =
		stopTarget && stopTargetLoaded && goToCall ? (
			<GoToCallButton
				label="Go to the call that started this task"
				onClick={() => goToCall(stopTarget)}
			/>
		) : (
			changeHeader.actions
		);
	// A change is drawn from the input, so its result is shown nowhere else —
	// and when the tool refused it, or the user denied it, the result is the
	// reason.
	const changeError = change && refused ? result : "";
	// Gated the same way: counting means splitting the whole output.
	const count = useMemo(
		() =>
			everExpanded && showsResult
				? resultCount(run.name, run.input, result, run.contents)
				: undefined,
		[everExpanded, showsResult, run.name, run.input, result, run.contents],
	);

	// The viewer's title is the row's, as the row reads it.
	const fullScreenTitle = toolSummaryLine(summary);
	const subject = useMemo(
		() => fullScreenSubject(run.name, run.input),
		[run.name, run.input],
	);
	// One key for the live output and the result that replaces it, so a viewer
	// opened on the one carries on into the other.
	const resultKey = `${run.id}:result`;
	// The reducer's whole buffer, not the body's last lines: the viewer has the
	// room for it.
	const liveFullScreen = useMemo<SectionFullScreen | undefined>(
		() =>
			live && run.output
				? {
						key: resultKey,
						title: fullScreenTitle,
						subject,
						content: {
							kind: "output",
							text: run.output,
							live: { droppedLines: run.outputDroppedLines ?? 0 },
						},
					}
				: undefined,
		[
			live,
			run.output,
			run.outputDroppedLines,
			resultKey,
			fullScreenTitle,
			subject,
		],
	);
	// Gated as the copy text is: building it reads the whole result.
	const outcomeFullScreen = useMemo<SectionFullScreen | undefined>(
		() =>
			everExpanded && showsResult
				? {
						key: resultKey,
						title: fullScreenTitle,
						subject,
						content: resultFullScreenContent(run.name, run.input, result, {
							contents: run.contents,
							failed,
							onOpenFile,
						}),
					}
				: undefined,
		[
			everExpanded,
			showsResult,
			resultKey,
			fullScreenTitle,
			subject,
			run.name,
			run.input,
			result,
			run.contents,
			failed,
			onOpenFile,
		],
	);

	// A Codex web call answers the model and reports nothing of what it read,
	// so where a search's results or a page would be, the body says that —
	// an empty section would read as a search that found nothing. Only Codex
	// succeeds with nothing: Claude's result always carries a header.
	const unreported =
		(run.name === "WebSearch" || run.name === "WebFetch") &&
		run.status === "success" &&
		!run.result &&
		!run.contents;
	// What an image generation asked is the prompt its result names, once there
	// is one: shown once, as the result. One that returned without naming it
	// says so, rather than still promising it.
	const promptUnnamed = generation && run.status === "success" && !imagePrompt;
	const invocation = imagePrompt ? null : promptUnnamed ? (
		<p className="text-th-text-muted">Codex did not name the prompt it used.</p>
	) : (
		<ToolInvocation
			toolName={run.name}
			input={run.input}
			onOpenFile={onOpenFile}
			fullScreen={{ key: `${run.id}:plan`, title: fullScreenTitle }}
			// Folded only once there is an answer to read instead; until then the
			// call is all the body has to say. Read when the body first mounts,
			// so a result arriving later does not fold what the user is reading.
			collapsible={
				layout.resultFirst ? { defaultOpen: !showsResult } : undefined
			}
		/>
	);

	const outcome = (
		<>
			{run.name === "NotebookEdit" && (
				<NotebookCellSection
					run={run}
					title={fullScreenTitle}
					subject={subject}
					refused={refused}
				/>
			)}
			{liveOutput && (
				<Section
					label="Output so far"
					noun="output"
					fullScreen={liveFullScreen}
					budget="main"
					clampFrom="end"
					follow
					count={{ noun: "line", total: outputLineCount(liveOutput) }}
				>
					<pre className="whitespace-pre-wrap font-mono text-th-text-muted">
						{liveOutput}
					</pre>
				</Section>
			)}
			{unreported && (
				<Section label={layout.resultLabel}>
					<p className="text-th-text-muted">
						{run.name === "WebSearch"
							? "Codex does not report what the search found."
							: "Codex does not report what the page said."}
					</p>
				</Section>
			)}
			{changeError && (
				// A deny is a decision, not a failure: its refusal reads plain.
				<Section label={failed ? "Error" : "Result"}>
					<pre
						className={`whitespace-pre-wrap break-words font-mono ${failed ? FAILURE_TEXT : "text-th-text-secondary"}`}
					>
						{changeError}
					</pre>
				</Section>
			)}
			<ToolOutcomeSections
				run={run}
				outcomeLabel={
					failed
						? (layout.failedLabel ?? layout.resultLabel)
						: layout.resultLabel
				}
				outcomeClampFrom={layout.resultFromEnd ? "end" : undefined}
				outcomeCount={count}
				outcomeMeta={changeHeader.meta}
				outcomeActions={outcomeActions}
				outcomeCopyText={copyText}
				outcomeFullScreen={outcomeFullScreen}
				outcome={
					showsResult && (
						<>
							<ToolResultDisplay
								toolName={run.name}
								toolInput={run.input}
								result={result}
								contents={run.contents}
								onOpenFile={onOpenFile}
								failed={failed}
							/>
							{/* No condition of its own: a reference can only have come
							    from `run.contents`, which is half of `showsResult`. */}
							{references.map((file) => (
								<ReferenceLine
									key={file.path}
									file={file}
									onOpenFile={onOpenFile}
								/>
							))}
						</>
					)
				}
			/>
		</>
	);

	return (
		<div className="text-xs" data-tool-use-id={run.id}>
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={<ToolStatusGlyph status={look} name={run.name} />}
				title={summary.title}
				// About agents, though not one: no Process and no steps.
				agent={run.name === AGENT_CONTROL_TOOL}
				chip={summary.chip}
				background={run.fromBackground}
				afterStop={run.finishedAfterStop}
				detail={summary.detail}
				detailTail={summary.detailTail}
				detailMono={summary.mono}
				meta={<ToolMeta run={run} />}
				secondLine={toolSecondLine(run)}
				error={failed}
			/>
			{verdict && (
				<VerdictLine verdict={verdict} reviewing={false} expanded={expanded} />
			)}
			{attachments.length > 0 && (
				<AttachmentStrip
					files={attachments}
					sessionId={sessionId}
					onOpenFile={onOpenFile}
				/>
			)}
			<CollapsibleBody expanded={expanded}>
				{/* No height of its own and no scroller: each block clamps itself
				    (`Section`), because a scroll box inside the transcript takes the
				    drag a phone meant for the page. No `useEverExpanded` gate either:
				    `CollapsibleBody` renders nothing at all until the body is first
				    opened, so the pretty-printing and the highlighting below are
				    already paid for only once somebody asks. */}
				<div className="space-y-3 border-t border-th-border bg-th-bg-secondary p-2">
					{run.permission && (
						<PermissionAnswerNote permission={run.permission} />
					)}
					{workTarget && (
						<WorkRefLine
							label={workKindWord(workTarget.kind)}
							title={workTarget.title}
							mono={workTarget.mono}
							openId={workTarget.openId}
							onOpen={openWorkDetail}
						/>
					)}
					{layout.resultFirst ? (
						<>
							{outcome}
							{invocation}
						</>
					) : (
						<>
							{invocation}
							{outcome}
						</>
					)}
					{/* Not for work lost with the process: nothing of it returned,
					    and its result is Pockode saying so. */}
					{run.status === "interrupted" &&
						showsResult &&
						!run.lostWithProcess && (
							<p className="text-th-text-muted">
								{run.finishedAfterStop
									? "Finished after the turn was stopped."
									: "Returned after the turn was interrupted."}
							</p>
						)}
				</div>
			</CollapsibleBody>
		</div>
	);
});

export default ToolCallItem;
