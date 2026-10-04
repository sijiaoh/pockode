import { AnsiUp } from "ansi_up";
import { useMemo } from "react";
import { groupContentBlocks } from "../../lib/contentBlocks";
import { proposedChange, proposedChangeText } from "../../lib/proposedChange";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { parseReadResult } from "../../lib/toolResultParser";
import { useWSStore } from "../../lib/wsStore";
import type { ContentBlock } from "../../types/content";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { formatFilePath, relativeToWorkDir } from "../../utils/path";
import { FileContentDisplay, MarkdownContent } from "../ui";
import { ProposedChange } from "./ProposedChange";

const ansiUp = new AnsiUp();
ansiUp.use_classes = true;

interface ToolResultDisplayProps {
	toolName: string;
	toolInput: unknown;
	result: string;
	/** Absent when the host cannot navigate to a file. */
	onOpenFile?: (path: string) => void;
	/**
	 * The result in blocks, when the agent returned something that is not prose.
	 * It then describes the whole result and `result` is empty, so it decides how
	 * the body is rendered — the per-tool views below read a result's text, and
	 * there is none to read.
	 */
	contents?: ContentBlock[];
	/** Whether the call failed, which a command's output shows at its end. */
	failed?: boolean;
}

/** The file a `Read` returned, without the line numbers the CLI prefixes. */
function readResultCode(result: string): string {
	const lines = parseReadResult(result);
	if (lines.length === 0) return result;
	return lines.map((l) => l.content).join("\n");
}

function ReadResultDisplay({
	result,
	filePath,
}: {
	result: string;
	filePath?: string;
}) {
	const code = useMemo(() => readResultCode(result), [result]);

	return (
		<FileContentDisplay content={code} filePath={filePath} copyable={false} />
	);
}

/**
 * How many files a search result is drawn as rows before the rest is left as
 * text. A `Glob` over a large repository answers with thousands, and a row each
 * is thousands of DOM nodes in a body nobody has finished reading; the ones
 * past this are the ones a person was going to refine the search for anyway.
 */
const FILE_LIST_LIMIT = 100;

/**
 * A search's result is a list of files, and reading one is scanning for a
 * name. Drawn as rows shortened against the work directory, each offering the
 * way over to the Files tab — before this it was one long unwrapped line.
 */
function FileListDisplay({
	result,
	onOpenFile,
}: {
	result: string;
	onOpenFile?: (path: string) => void;
}) {
	const workDir = useWSStore((s) => s.workDir);
	const paths = useMemo(
		() =>
			result
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0),
		[result],
	);

	// Grep answers with counts and matches too, depending on its mode; only a
	// list of paths is a list of paths.
	if (paths.length === 0 || paths.some((path) => path.includes(" "))) {
		return (
			<pre className="whitespace-pre-wrap text-th-text-muted">{result}</pre>
		);
	}

	const shown = paths.slice(0, FILE_LIST_LIMIT);

	return (
		<div className="space-y-0.5">
			{shown.map((path) => {
				const relative = relativeToWorkDir(path, workDir);
				return (
					<div key={path} className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate text-th-text-primary">
							{formatFilePath(path, workDir)}
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
			})}
			{paths.length > shown.length && (
				<p className="text-th-text-muted">
					and {paths.length - shown.length} more
				</p>
			)}
		</div>
	);
}

/**
 * Whatever a tool Pockode has no view for answered with.
 *
 * JSON is pretty-printed and highlighted — MCP tools answer with it, and one
 * long line of it was a horizontal scroll on a phone. Everything else wraps,
 * which the bare `<pre>` this replaces did not do either.
 *
 * Past `HIGHLIGHT_LIMIT` it is left alone: shiki tokenizes on the main thread,
 * and a tool that answered with a megabyte would freeze the transcript for
 * seconds — the same ceiling the file viewer uses, for the same reason.
 */
function UnknownResultDisplay({ result }: { result: string }) {
	const pretty = useMemo(() => {
		if (result.length > HIGHLIGHT_LIMIT) return null;
		const trimmed = result.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
		try {
			return JSON.stringify(JSON.parse(trimmed), null, 2);
		} catch {
			return null;
		}
	}, [result]);

	if (pretty)
		return (
			<CodeHighlighter language="json" copyable={false}>
				{pretty}
			</CodeHighlighter>
		);
	return <pre className="whitespace-pre-wrap text-th-text-muted">{result}</pre>;
}

/**
 * How many of a failed command's last lines are marked as its error. The
 * failure is nearly always said at the end — a compiler's last errors, a test
 * runner's `FAIL` — and a handful of lines holds it without painting a whole
 * log red.
 */
const ERROR_TAIL_LINES = 5;

/**
 * How text that says why a call failed is drawn in its body — a failed
 * command's last lines, a refused change's reason: red, on a red bar, so it is
 * found without reading the rest.
 */
export const FAILURE_TEXT =
	"border-l-2 border-th-error bg-th-error/10 pl-2 text-th-error";

function outputLines(result: string): string[] {
	return result.replace(/\n+$/, "").split("\n");
}

/** What the output's *Show all* says: a log is measured in lines. */
export function outputLineCount(result: string): number {
	return outputLines(result).length;
}

function AnsiPre({ text, className }: { text: string; className: string }) {
	const html = useMemo(() => ansiUp.ansi_to_html(text), [text]);

	return (
		<pre
			className={`whitespace-pre-wrap break-words font-mono text-xs ${className}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: ansi_up output is safe
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

/**
 * A command's output, wrapped: a log line is read whole, and on a phone a
 * sideways scroll hid the end of nearly every one. A failed command's last
 * lines stand out, since that is where it says why.
 */
function BashResultDisplay({
	result,
	failed,
}: {
	result: string;
	failed?: boolean;
}) {
	const [head, tail] = useMemo(() => {
		if (!failed) return [result, ""];
		const lines = outputLines(result);
		return [
			lines.slice(0, -ERROR_TAIL_LINES).join("\n"),
			lines.slice(-ERROR_TAIL_LINES).join("\n"),
		];
	}, [result, failed]);

	return (
		<>
			{head && <AnsiPre text={head} className="text-th-text-muted" />}
			{tail && <AnsiPre text={tail} className={FAILURE_TEXT} />}
		</>
	);
}

// Built rather than written as a literal: a control character in a regex
// literal is almost always a mistake, and the linter says so.
const ANSI_ESCAPE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
	"g",
);

/**
 * What the result block's copy button copies: the text a reader would select
 * out of it, which is not always the result as it arrived — a `Read` comes back
 * line-numbered and a command's output carries colour codes. Nothing for a
 * result that is not text to begin with: a diff, content blocks.
 */
export function resultCopyText(
	toolName: string,
	toolInput: unknown,
	result: string,
	contents?: ContentBlock[],
): string | undefined {
	if (contents) return undefined;

	switch (toolName) {
		case "Read":
			return readResultCode(result);
		case "Bash":
			return result.replace(ANSI_ESCAPE, "");
		case "Edit":
		case "MultiEdit":
		case "Write": {
			const change = proposedChange(toolName, toolInput);
			if (change) return proposedChangeText(change);
			return result || undefined;
		}
		default:
			return result || undefined;
	}
}

/**
 * The names a tool search answered with.
 *
 * A row of labels rather than a list of lines: what the agent got back is a set
 * of names, and reading them is scanning for one, not reading prose.
 */
function ToolReferenceList({ names }: { names: string[] }) {
	return (
		<div className="flex flex-wrap gap-1">
			{names.map((name, index) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: a settled result's blocks are fixed — nothing is inserted, removed or reordered
					key={index}
					className="rounded bg-th-bg-tertiary px-1.5 py-0.5 text-th-accent"
				>
					{name}
				</span>
			))}
		</div>
	);
}

function ContentBlocksDisplay({ blocks }: { blocks: ContentBlock[] }) {
	const groups = useMemo(() => groupContentBlocks(blocks), [blocks]);

	return (
		<div className="space-y-2">
			{groups.map((group, index) =>
				group.kind === "tools" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: as above — the groups of a settled result never change
					<ToolReferenceList key={index} names={group.names} />
				) : (
					<pre
						// biome-ignore lint/suspicious/noArrayIndexKey: as above
						key={index}
						className="whitespace-pre-wrap text-th-text-muted"
					>
						{group.text}
					</pre>
				),
			)}
		</div>
	);
}

function ToolResultDisplay({
	toolName,
	toolInput,
	result,
	contents,
	onOpenFile,
	failed,
}: ToolResultDisplayProps) {
	const input = toolInput as Record<string, unknown>;
	const filePath =
		typeof input?.file_path === "string" ? input.file_path : undefined;
	if (contents) {
		return <ContentBlocksDisplay blocks={contents} />;
	}

	switch (toolName) {
		case "Grep":
			// Only the mode that answers with paths. `content` and `count` put a
			// `path:line:` prefix on every line, and a short match with no space
			// in it would pass the shape check below and be drawn as a file that
			// does not exist.
			if (
				input.output_mode !== undefined &&
				input.output_mode !== "files_with_matches"
			) {
				return (
					<pre className="whitespace-pre-wrap text-th-text-muted">{result}</pre>
				);
			}
			return <FileListDisplay result={result} onOpenFile={onOpenFile} />;
		case "Glob":
			return <FileListDisplay result={result} onOpenFile={onOpenFile} />;

		// The result is Markdown, and there is a renderer for that.
		case "WebFetch":
			return <MarkdownContent content={result} />;

		case "Read":
			return <ReadResultDisplay result={result} filePath={filePath} />;

		// What a file tool did is what it was asked to do: the view reads the
		// input alone, and the permission card draws the same one before it runs.
		case "Edit":
		case "MultiEdit":
		case "Write": {
			const change = proposedChange(toolName, toolInput);
			if (change) return <ProposedChange change={change} />;
			return <UnknownResultDisplay result={result} />;
		}

		case "Bash":
			return <BashResultDisplay result={result} failed={failed} />;

		default:
			return <UnknownResultDisplay result={result} />;
	}
}

export default ToolResultDisplay;
