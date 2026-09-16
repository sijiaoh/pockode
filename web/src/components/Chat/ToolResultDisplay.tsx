import { AnsiUp } from "ansi_up";
import { createPatch } from "diff";
import { Check, Circle, Loader2 } from "lucide-react";
import { useMemo } from "react";
import {
	type CodexChangeView,
	parseCodexChanges,
} from "../../lib/codexChanges";
import { groupContentBlocks } from "../../lib/contentBlocks";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { parseReadResult } from "../../lib/toolResultParser";
import { useWSStore } from "../../lib/wsStore";
import type { ContentBlock } from "../../types/content";
import { GIT_STATUS_INFO } from "../../types/git";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { formatFilePath, relativeToWorkDir } from "../../utils/path";
import { DiffViewer, FileContentDisplay } from "../ui";
import { MarkdownContent } from "./MarkdownContent";

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
}

interface EditInput {
	file_path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

interface WriteInput {
	file_path: string;
	content: string;
}

interface MultiEditInput {
	file_path: string;
	edits: Array<{ old_string: string; new_string: string }>;
}

interface TodoWriteInput {
	todos: Array<{
		content: string;
		status: "pending" | "in_progress" | "completed";
		activeForm: string;
	}>;
}

function ReadResultDisplay({
	result,
	filePath,
}: {
	result: string;
	filePath?: string;
}) {
	const lines = useMemo(() => parseReadResult(result), [result]);
	const code = useMemo(() => lines.map((l) => l.content).join("\n"), [lines]);

	if (lines.length === 0) {
		return <FileContentDisplay content={result} filePath={filePath} />;
	}

	return <FileContentDisplay content={code} filePath={filePath} />;
}

function EditResultDisplay({ input }: { input: EditInput }) {
	const unifiedDiff = useMemo(
		() => createPatch(input.file_path, input.old_string, input.new_string),
		[input.file_path, input.old_string, input.new_string],
	);

	return <DiffViewer fileName={input.file_path} hunks={[unifiedDiff]} />;
}

function CodexEditResultDisplay({ changes }: { changes: CodexChangeView[] }) {
	const workDir = useWSStore((s) => s.workDir);

	return (
		<div className="space-y-3">
			{changes.map((change) => (
				<div key={change.path} className="space-y-1">
					<div className="flex items-center gap-2 text-sm">
						<span
							className={`shrink-0 font-mono ${GIT_STATUS_INFO[change.status].color}`}
							// "?" means an unknown change type here, not git's "Untracked".
							title={
								change.status === "?"
									? change.note
									: GIT_STATUS_INFO[change.status].label
							}
						>
							{change.status}
						</span>
						<span
							className="truncate text-th-text-primary"
							title={change.newPath}
						>
							{formatFilePath(change.newPath, workDir)}
						</span>
					</div>
					{change.newPath !== change.path && (
						<div className="text-th-text-muted text-xs" title={change.path}>
							from {formatFilePath(change.path, workDir)}
						</div>
					)}
					{change.patch ? (
						<DiffViewer fileName={change.newPath} hunks={[change.patch]} />
					) : (
						<p className="text-th-text-muted">
							{change.note ?? "No diff to show"}
						</p>
					)}
				</div>
			))}
		</div>
	);
}

function MultiEditResultDisplay({ input }: { input: MultiEditInput }) {
	const diffs = useMemo(
		() =>
			input.edits.map((edit, index) => ({
				index,
				patch: createPatch(input.file_path, edit.old_string, edit.new_string),
			})),
		[input.file_path, input.edits],
	);

	return (
		<div className="space-y-2">
			{diffs.map(({ index, patch }) => (
				<DiffViewer key={index} fileName={input.file_path} hunks={[patch]} />
			))}
		</div>
	);
}

function WriteResultDisplay({ input }: { input: WriteInput }) {
	return (
		<FileContentDisplay content={input.content} filePath={input.file_path} />
	);
}

function TodoWriteResultDisplay({ input }: { input: TodoWriteInput }) {
	const getStatusIcon = (status: TodoWriteInput["todos"][number]["status"]) => {
		switch (status) {
			case "completed":
				return <Check className="size-4 text-th-success" />;
			case "in_progress":
				return <Loader2 className="size-4 text-th-warning" />;
			case "pending":
				return <Circle className="size-4 text-th-text-muted" />;
		}
	};

	return (
		<div className="space-y-1 text-sm">
			{input.todos.map((todo, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: todos have no unique identifier
					key={index}
					className="flex items-center gap-2"
				>
					{getStatusIcon(todo.status)}
					<span
						className={
							todo.status === "completed"
								? "text-th-text-muted line-through"
								: ""
						}
					>
						{todo.content}
					</span>
				</div>
			))}
		</div>
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
		return <CodeHighlighter language="json">{pretty}</CodeHighlighter>;
	return <pre className="whitespace-pre-wrap text-th-text-muted">{result}</pre>;
}

function BashResultDisplay({ result }: { result: string }) {
	const html = useMemo(() => ansiUp.ansi_to_html(result), [result]);

	return (
		<pre
			className="font-mono text-xs text-th-text-muted"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: ansi_up output is safe
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

function isEditInput(input: unknown): input is EditInput {
	const i = input as Record<string, unknown>;
	return (
		typeof i?.file_path === "string" &&
		typeof i?.old_string === "string" &&
		typeof i?.new_string === "string"
	);
}

function isWriteInput(input: unknown): input is WriteInput {
	const i = input as Record<string, unknown>;
	return typeof i?.file_path === "string" && typeof i?.content === "string";
}

function isMultiEditInput(input: unknown): input is MultiEditInput {
	const i = input as Record<string, unknown>;
	return typeof i?.file_path === "string" && Array.isArray(i?.edits);
}

function isTodoWriteInput(input: unknown): input is TodoWriteInput {
	const i = input as Record<string, unknown>;
	return Array.isArray(i?.todos) && i.todos.length > 0;
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
}: ToolResultDisplayProps) {
	const input = toolInput as Record<string, unknown>;
	const filePath =
		typeof input?.file_path === "string" ? input.file_path : undefined;
	// Memoized because building add/delete patches diffs whole file contents,
	// and a streaming session re-renders this tree while it stays expanded.
	const codexChanges = useMemo(() => parseCodexChanges(toolInput), [toolInput]);

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

		case "Edit":
			if (isEditInput(toolInput)) {
				return <EditResultDisplay input={toolInput} />;
			}
			if (codexChanges) {
				return <CodexEditResultDisplay changes={codexChanges} />;
			}
			return <UnknownResultDisplay result={result} />;

		case "MultiEdit":
			if (isMultiEditInput(toolInput)) {
				return <MultiEditResultDisplay input={toolInput} />;
			}
			return <UnknownResultDisplay result={result} />;

		case "Write":
			if (isWriteInput(toolInput)) {
				return <WriteResultDisplay input={toolInput} />;
			}
			return <UnknownResultDisplay result={result} />;

		case "Bash":
			return <BashResultDisplay result={result} />;

		case "TodoWrite":
			if (isTodoWriteInput(toolInput)) {
				return <TodoWriteResultDisplay input={toolInput} />;
			}
			return <pre className="text-th-text-muted">{result}</pre>;

		default:
			return <UnknownResultDisplay result={result} />;
	}
}

export default ToolResultDisplay;
