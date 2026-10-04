import { memo, useMemo } from "react";
import {
	contentBlockFiles,
	type FileReference,
	partitionFileBlocks,
} from "../../lib/contentBlocks";
import { toolBodyLayout } from "../../lib/toolBodyLayout";
import { lastOutputLines, toolSecondLine } from "../../lib/toolRun";
import { toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { ToolRun } from "../../types/message";
import { omittedLabel } from "../../utils/attachment";
import { CollapsibleBody, useEverExpanded } from "../ui";
import AttachmentStrip from "./AttachmentStrip";
import { proposedChange, proposedChangeHeader } from "./ProposedChange";
import { useRowExpanded } from "./rowExpansionContext";
import { PathLine, ToolInvocation } from "./ToolInvocation";
import { ToolOutcomeSections } from "./ToolOutcomeSections";
import ToolResultDisplay, {
	outputLineCount,
	resultCopyText,
} from "./ToolResultDisplay";
import { ToolMeta, ToolRow, ToolStatusGlyph } from "./ToolRow";
import { Section } from "./ToolSection";

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
		() => toolSummary(run.name, run.input, workDir),
		[run.name, run.input, workDir],
	);
	// Nothing opens this body but the user. A failure used to pry it open once,
	// back when a failed row said only *that* it failed; now it says how, on its
	// second line. Trial and error is how an agent works, so a turn with four
	// failed calls in it is ordinary — and four bodies unfolding themselves bury
	// the answer the user is actually reading.
	const failed = run.status === "error";

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
	const liveOutput =
		live && run.output ? lastOutputLines(run.output, LIVE_OUTPUT_LINES) : "";
	const layout = toolBodyLayout(run.name);
	// A result that only acknowledges the call is no answer to show.
	const showsResult =
		Boolean(run.result || run.contents) &&
		!(layout.resultIsAcknowledgement && !failed);
	// Eager rather than a function handed to the button, because whether there
	// is anything to copy decides whether there is a button. Gated on the body
	// having been opened: a collapsed `Read` should not pay to strip its line
	// numbers.
	const everExpanded = useEverExpanded(expanded);
	const copyText = useMemo(
		() =>
			everExpanded && showsResult
				? resultCopyText(run.name, run.input, run.result ?? "", run.contents)
				: undefined,
		[everExpanded, showsResult, run.name, run.input, run.result, run.contents],
	);
	// Gated the same way: counting means reading the whole diff. Mirrors when
	// `ToolResultDisplay` draws the change rather than content blocks.
	const changeHeader = useMemo(
		() =>
			everExpanded && showsResult && !run.contents
				? proposedChangeHeader(proposedChange(run.name, run.input))
				: {},
		[everExpanded, showsResult, run.name, run.input, run.contents],
	);
	// Gated the same way: counting means splitting the whole output.
	const showAllLabel = useMemo(
		() =>
			everExpanded && layout.resultFromEnd && run.result
				? `Show all ${outputLineCount(run.result)} lines`
				: undefined,
		[everExpanded, layout.resultFromEnd, run.result],
	);

	const invocation = (
		<ToolInvocation
			toolName={run.name}
			input={run.input}
			onOpenFile={onOpenFile}
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
			{liveOutput && (
				<Section label="Output so far" clampFrom="end">
					<pre className="whitespace-pre-wrap font-mono text-th-text-muted">
						{liveOutput}
					</pre>
				</Section>
			)}
			<ToolOutcomeSections
				run={run}
				outcomeLabel={layout.resultLabel}
				outcomeClampFrom={layout.resultFromEnd ? "end" : undefined}
				outcomeShowAllLabel={showAllLabel}
				outcomeMeta={changeHeader.meta}
				outcomeActions={changeHeader.actions}
				outcomeCopyText={copyText}
				outcomeFullScreenTitle={
					layout.fullScreen
						? [summary.title, summary.detail + summary.detailTail]
								.filter(Boolean)
								.join(" · ")
						: undefined
				}
				outcome={
					showsResult && (
						<>
							<ToolResultDisplay
								toolName={run.name}
								toolInput={run.input}
								result={run.result ?? ""}
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
		<div className="text-xs">
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={<ToolStatusGlyph status={run.status} name={run.name} />}
				title={summary.title}
				chip={summary.chip}
				background={run.fromBackground}
				detail={summary.detail}
				detailTail={summary.detailTail}
				detailMono={summary.mono}
				meta={<ToolMeta run={run} />}
				secondLine={toolSecondLine(run)}
				error={failed}
			/>
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
					{run.exitCode !== undefined && run.exitCode !== 0 && (
						<p className="text-th-text-muted">Exit code {run.exitCode}</p>
					)}
					{run.status === "interrupted" && showsResult && (
						<p className="text-th-text-muted">
							Returned after the turn was interrupted.
						</p>
					)}
				</div>
			</CollapsibleBody>
		</div>
	);
});

export default ToolCallItem;
