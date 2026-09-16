import { memo, useEffect, useMemo, useRef, useState } from "react";
import { contentBlockFiles } from "../../lib/contentBlocks";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { lastOutputLines, toolSecondLine } from "../../lib/toolRun";
import { toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { ToolRun } from "../../types/message";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { relativeToWorkDir } from "../../utils/path";
import { CollapsibleBody, ScrollableContent } from "../ui";
import AttachmentStrip from "./AttachmentStrip";
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

function Section({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1">
			<p className="text-th-text-muted">{label}</p>
			{children}
		</div>
	);
}

/** A path in full, with the way over to the Files tab when there is one. */
function PathLine({
	path,
	onOpenFile,
}: {
	path: string;
	onOpenFile?: (path: string) => void;
}) {
	const workDir = useWSStore((state) => state.workDir);
	const relative = relativeToWorkDir(path, workDir);

	return (
		<div className="flex items-start gap-2">
			<span className="min-w-0 flex-1 break-all font-mono text-th-text-primary">
				{path}
			</span>
			{relative && onOpenFile && (
				<button
					type="button"
					onClick={() => onOpenFile(relative)}
					className="min-h-[36px] shrink-0 rounded px-2 text-th-accent pointer-coarse:min-h-11 hover:bg-th-overlay-hover"
				>
					Open
				</button>
			)}
		</div>
	);
}

function asObject(input: unknown): Record<string, unknown> {
	return input && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

/**
 * What the agent asked for, in full — the answer to a row that truncated it.
 *
 * Always present, which is what makes the chevron unconditional: before this
 * section existed a running call and a call that answered with an image alone
 * could not be opened at all.
 *
 * `command_actions` is Codex's parse of the command and is the row's title
 * already; repeating the array here would only ask the reader to parse it
 * again.
 */
function ToolInvocation({
	run,
	onOpenFile,
}: {
	run: ToolRun;
	onOpenFile?: (path: string) => void;
}) {
	const input = asObject(run.input);
	const description =
		typeof input.description === "string" ? input.description : null;

	const json = useMemo(() => {
		try {
			return JSON.stringify(run.input, null, 2);
		} catch {
			return String(run.input);
		}
	}, [run.input]);
	// Shiki tokenizes on the main thread, so an argument past the viewer's own
	// ceiling is shown as plain text rather than freezing the transcript.
	const plain = json.length > HIGHLIGHT_LIMIT;

	if (run.name === "Bash" && typeof input.command === "string") {
		return (
			<Section label="Invocation">
				{description && <p className="text-th-text-muted">{description}</p>}
				<CodeHighlighter
					language="bash"
					plain={input.command.length > HIGHLIGHT_LIMIT}
				>
					{input.command}
				</CodeHighlighter>
			</Section>
		);
	}

	// Before the path branch, exactly as `toolSummary` orders them: a search's
	// `path` is the scope it ran in, not what it was looking for. Taking that
	// branch first would leave the pattern — the whole of what the row
	// truncated — in no part of the body at all.
	if (run.name === "Grep" || run.name === "Glob") {
		return (
			<Section label="Invocation">
				<dl className="space-y-0.5">
					{Object.entries(input).map(([key, value]) => (
						<div key={key} className="flex gap-2">
							<dt className="shrink-0 text-th-text-muted">{key}</dt>
							<dd className="min-w-0 break-all font-mono text-th-text-primary">
								{typeof value === "string" ? value : JSON.stringify(value)}
							</dd>
						</div>
					))}
				</dl>
			</Section>
		);
	}

	const filePath =
		typeof input.file_path === "string"
			? input.file_path
			: typeof input.path === "string"
				? input.path
				: null;
	if (filePath) {
		return (
			<Section label="Invocation">
				<PathLine path={filePath} onOpenFile={onOpenFile} />
			</Section>
		);
	}

	return (
		<Section label="Invocation">
			<CodeHighlighter language="json" plain={plain}>
				{json}
			</CodeHighlighter>
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
	const [expanded, setExpanded] = useState(false);
	const workDir = useWSStore((state) => state.workDir);
	const summary = useMemo(
		() => toolSummary(run.name, run.input, workDir),
		[run.name, run.input, workDir],
	);
	const failed = run.status === "error";
	// A failure has to be read, but only pries the body open once — after that
	// the user's own choice to collapse it stands. A background run is never
	// auto-expanded: a 30-minute task that unfolds itself would shove the
	// transcript around long after the user stopped caring.
	const autoExpandedRef = useRef(false);

	useEffect(() => {
		if (failed && !autoExpandedRef.current) {
			autoExpandedRef.current = true;
			setExpanded(true);
		}
	}, [failed]);

	const files = useMemo(
		() =>
			run.contents
				? contentBlockFiles(run.contents, { name: run.name, input: run.input })
				: [],
		[run.contents, run.name, run.input],
	);

	const live = run.status === "running" || run.status === "background";
	const liveOutput =
		live && run.output ? lastOutputLines(run.output, LIVE_OUTPUT_LINES) : "";
	const hasResult = Boolean(run.result || run.contents);

	return (
		<div
			className={`rounded bg-th-bg-secondary text-xs ${failed ? "border border-th-error/40" : ""}`}
		>
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
			{files.length > 0 && (
				<AttachmentStrip
					files={files}
					sessionId={sessionId}
					onOpenFile={onOpenFile}
				/>
			)}
			<CollapsibleBody expanded={expanded}>
				<ScrollableContent className="max-h-[60vh] space-y-3 overflow-auto border-t border-th-border p-2">
					{/* No `useEverExpanded` gate: `CollapsibleBody` renders nothing
					    at all until the body is first opened, so the pretty-printing
					    and the highlighting below are already paid for only once
					    somebody asks. */}
					<ToolInvocation run={run} onOpenFile={onOpenFile} />
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
					{run.placeholderResult && (
						// What the agent read, kept beside the outcome below: showing
						// only the outcome would assert the agent saw something it never
						// did.
						<Section label="Returned to the agent">
							<pre className="whitespace-pre-wrap text-th-text-muted">
								{run.placeholderResult}
							</pre>
						</Section>
					)}
					{hasResult && (
						<Section
							label={run.fromBackground ? "Outcome · after the turn" : "Result"}
						>
							<ToolResultDisplay
								toolName={run.name}
								toolInput={run.input}
								result={run.result ?? ""}
								contents={run.contents}
								onOpenFile={onOpenFile}
							/>
						</Section>
					)}
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
