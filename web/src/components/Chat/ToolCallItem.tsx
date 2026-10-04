import { memo, useMemo } from "react";
import {
	contentBlockFiles,
	type FileReference,
	partitionFileBlocks,
} from "../../lib/contentBlocks";
import { lastOutputLines, toolSecondLine } from "../../lib/toolRun";
import { toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { ToolRun } from "../../types/message";
import { omittedLabel } from "../../utils/attachment";
import { CollapsibleBody, ScrollableContent } from "../ui";
import AttachmentStrip from "./AttachmentStrip";
import { useRowExpanded } from "./rowExpansionContext";
import { PathLine, ToolInvocation } from "./ToolInvocation";
import { Section, ToolOutcomeSections } from "./ToolOutcomeSections";
import ToolResultDisplay from "./ToolResultDisplay";
import { ToolMeta, ToolRow, ToolStatusGlyph } from "./ToolRow";

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
 * The full path, not the file name the block also carries: the body does not
 * truncate, so the tail of the path *is* the name and a second copy of it would
 * only take a line.
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
	const hasResult = Boolean(run.result || run.contents);

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
				<ScrollableContent className="max-h-[60vh] space-y-3 overflow-auto border-t border-th-border bg-th-bg-secondary p-2">
					{/* No `useEverExpanded` gate: `CollapsibleBody` renders nothing
					    at all until the body is first opened, so the pretty-printing
					    and the highlighting below are already paid for only once
					    somebody asks. */}
					<ToolInvocation
						toolName={run.name}
						input={run.input}
						onOpenFile={onOpenFile}
					/>
					{liveOutput && (
						// No scroller of its own: `ScrollableContent` above already owns
						// one, and a scroll area inside a scroll area swallows the drag
						// that was meant for the transcript.
						<Section label="Output so far">
							<pre className="whitespace-pre-wrap font-mono text-th-text-muted">
								{liveOutput}
							</pre>
						</Section>
					)}
					<ToolOutcomeSections
						run={run}
						outcome={
							hasResult && (
								<>
									<ToolResultDisplay
										toolName={run.name}
										toolInput={run.input}
										result={run.result ?? ""}
										contents={run.contents}
										onOpenFile={onOpenFile}
									/>
									{/* No condition of its own: a reference can only have come
									    from `run.contents`, which is half of `hasResult`. */}
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
					{run.exitCode !== undefined && run.exitCode !== 0 && (
						<p className="text-th-text-muted">Exit code {run.exitCode}</p>
					)}
					{run.status === "interrupted" && hasResult && (
						<p className="text-th-text-muted">
							Returned after the turn was interrupted.
						</p>
					)}
				</ScrollableContent>
			</CollapsibleBody>
		</div>
	);
});

export default ToolCallItem;
