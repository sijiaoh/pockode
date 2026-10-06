import { Check, Circle, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { codexChangePaths } from "../../lib/codexChanges";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { pathParts } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { isSameNativePath, relativeToWorkDir } from "../../utils/path";
import { ClampedContent, HeaderCopyButton, MarkdownContent } from "../ui";
import { outputLineCount } from "./ToolResultDisplay";
import { Detail } from "./ToolRow";
import { Section } from "./ToolSection";
import { useTranscriptView } from "./transcriptViewContext";

/**
 * A path on one line, relative to the work directory when it is inside it,
 * with the way over to the Files tab when there is one.
 *
 * One line, cut from the left as the row cuts it: the absolute path broken
 * anywhere took four lines on a phone, most of them the work directory every
 * path here shares. A tap on it writes it out in full, absolute and wrapped —
 * the body keeps everything the row cuts, and a phone has no hover for a
 * tooltip to hold it.
 */
export function PathLine({
	path,
	onOpenFile,
	copyable = false,
}: {
	path: string;
	onOpenFile?: (path: string) => void;
	/**
	 * End the line with a copy button, for a path that stands as a block of its
	 * own and so has no header to carry one.
	 */
	copyable?: boolean;
}) {
	const workDir = useWSStore((state) => state.workDir);
	const relative = relativeToWorkDir(path, workDir);
	const { head, tail } = pathParts(path, workDir);
	const [whole, setWhole] = useState(false);

	return (
		<div className="flex items-center gap-2">
			<button
				type="button"
				aria-expanded={whole}
				onClick={() => setWhole(!whole)}
				className="flex min-h-[36px] min-w-0 flex-1 items-center text-left pointer-coarse:min-h-11"
			>
				{whole ? (
					<span className="min-w-0 break-all font-mono text-th-text-primary">
						{path}
					</span>
				) : (
					<Detail detail={head} detailTail={tail} mono />
				)}
			</button>
			{relative && onOpenFile && (
				<button
					type="button"
					onClick={() => onOpenFile(relative)}
					className="min-h-[36px] shrink-0 rounded px-2 text-th-accent pointer-coarse:min-h-11 hover:bg-th-overlay-hover"
				>
					Open
				</button>
			)}
			{copyable && <HeaderCopyButton text={path} label="Copy path" />}
		</div>
	);
}

function asObject(input: unknown): Record<string, unknown> {
	return input && typeof input === "object"
		? (input as Record<string, unknown>)
		: {};
}

type TodoStatus = "pending" | "in_progress" | "completed";

interface Todo {
	content: string;
	status: TodoStatus;
}

function todoList(input: Record<string, unknown>): Todo[] | null {
	const { todos } = input;
	if (!Array.isArray(todos) || todos.length === 0) return null;
	const valid = todos.every(
		(todo) =>
			typeof asObject(todo).content === "string" &&
			["pending", "in_progress", "completed"].includes(
				asObject(todo).status as string,
			),
	);
	return valid ? (todos as Todo[]) : null;
}

/**
 * How a call's input is drawn. `params` and `json` are the input in full; every
 * other kind is a reading of it, which is what tells the permission card
 * whether the raw input still has anything to add.
 */
export type InvocationView =
	| { kind: "plan"; plan: string }
	| {
			kind: "command";
			command: string;
			description: string | null;
			cwd: string | null;
	  }
	| { kind: "search"; entries: Array<[string, unknown]> }
	| { kind: "paths"; paths: string[] }
	| { kind: "todos"; todos: Todo[] }
	| { kind: "params"; entries: Array<[string, unknown]> }
	| { kind: "text"; text: string }
	| { kind: "json" };

export function invocationView(
	toolName: string,
	toolInput: unknown,
): InvocationView {
	// Nothing to parse: the input is already the sentence.
	if (typeof toolInput === "string") return { kind: "text", text: toolInput };

	const input = asObject(toolInput);

	if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
		return { kind: "plan", plan: input.plan };
	}

	if (toolName === "Bash" && typeof input.command === "string") {
		return {
			kind: "command",
			command: input.command,
			description:
				typeof input.description === "string" ? input.description : null,
			// Codex's, and only Codex's: which directory a command runs in is half of
			// what approving `rm -rf build` means.
			cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : null,
		};
	}

	if (toolName === "TodoWrite") {
		const todos = todoList(input);
		if (todos) return { kind: "todos", todos };
	}

	// Before the path branch, exactly as `toolSummary` orders them: a search's
	// `path` is the scope it ran in, not what it was looking for. Taking that
	// branch first would leave the pattern — the whole of what the row
	// truncated — in no part of the body at all.
	if (toolName === "Grep" || toolName === "Glob") {
		return { kind: "search", entries: Object.entries(input) };
	}

	// A Codex file change names its files only inside `changes`.
	if (toolName === "Edit") {
		const paths = codexChangePaths(input);
		if (paths) return { kind: "paths", paths };
	}

	const filePath =
		typeof input.file_path === "string"
			? input.file_path
			: typeof input.path === "string"
				? input.path
				: null;
	if (filePath) return { kind: "paths", paths: [filePath] };

	// A Codex approval that described nothing else (server/agent/codex
	// `describeApproval`): its `reason` is a sentence, and a sentence in a JSON
	// string is harder to read than the sentence.
	if (
		typeof input.reason === "string" &&
		Object.keys(input).every((key) => key === "reason" || key === "kind")
	) {
		return { kind: "text", text: input.reason };
	}

	// An MCP tool's arguments: named fields, read as such rather than as JSON.
	// An input that is not a plain object, or is an empty one, has no fields to
	// name and stays JSON.
	if (
		toolInput &&
		typeof toolInput === "object" &&
		!Array.isArray(toolInput) &&
		Object.keys(input).length > 0
	) {
		return { kind: "params", entries: Object.entries(input) };
	}

	return { kind: "json" };
}

/**
 * What an invocation block is called, by what it shows rather than by the tool:
 * a `Read` and an `Edit` both show a file. A plan stands without a label — it
 * is the whole of what is being asked.
 */
function invocationLabel(view: InvocationView): string {
	switch (view.kind) {
		case "command":
			return "Command";
		case "paths":
			return view.paths.length > 1 ? "Files" : "File";
		case "text":
			return "Request";
		case "todos":
			return "Todos";
		default:
			return "Parameters";
	}
}

function TodoIcon({ status }: { status: TodoStatus }) {
	switch (status) {
		case "completed":
			return <Check className="size-4 shrink-0 text-th-success" />;
		case "in_progress":
			return <Loader2 className="size-4 shrink-0 text-th-warning" />;
		case "pending":
			return <Circle className="size-4 shrink-0 text-th-text-muted" />;
	}
}

function TodoChecklist({ todos }: { todos: Todo[] }) {
	return (
		<ul className="space-y-1 text-sm">
			{todos.map((todo, index) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: todos have no unique identifier
					key={index}
					className="flex items-start gap-2"
				>
					{/* One line's height, so the icon sits on the first line of an
					    item that wraps. */}
					<span className="flex h-5 items-center">
						<TodoIcon status={todo.status} />
					</span>
					<span
						className={`min-w-0 break-words ${
							todo.status === "completed"
								? "text-th-text-muted line-through"
								: "text-th-text-primary"
						}`}
					>
						{todo.content}
					</span>
				</li>
			))}
		</ul>
	);
}

/**
 * Named fields, one to a line. A value goes under its name only when it does
 * not fit beside it, so `pattern: foo` stays one line and a paragraph-long
 * query does not squeeze its name into a column.
 *
 * A string is shown as the text it is, never quoted; anything else as the JSON
 * it would be, indented when it has structure of its own.
 */
function FieldList({ entries }: { entries: Array<[string, unknown]> }) {
	return (
		<dl className="space-y-1">
			{entries.map(([key, value]) => (
				<div key={key} className="flex flex-wrap gap-x-2">
					<dt className="max-w-full break-all text-th-text-muted">{key}</dt>
					<dd
						className={`min-w-0 max-w-full whitespace-pre-wrap break-words text-th-text-primary ${
							typeof value === "string" ? "" : "font-mono"
						}`}
					>
						{fieldValue(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}

function fieldValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	if (value && typeof value === "object") return JSON.stringify(value, null, 2);
	return JSON.stringify(value);
}

/**
 * What the agent asked for, in full — the answer to a row that truncated it,
 * and the body of the permission card that asks whether it may run.
 *
 * Always present on a tool row, which is what makes the chevron unconditional:
 * before this section existed a running call and a call that answered with an
 * image alone could not be opened at all.
 *
 * A command, fields and the JSON fallback wrap: they are read end to end
 * before they are approved, while a diff or a file reads by its lines and keeps
 * its own viewer's horizontal scroll.
 */
export function ToolInvocation({
	toolName,
	input,
	onOpenFile,
	collapsible,
}: {
	toolName: string;
	input: unknown;
	onOpenFile?: (path: string) => void;
	/** See `Section`. */
	collapsible?: { defaultOpen: boolean };
}) {
	const workDir = useWSStore((state) => state.workDir);
	const transcriptView = useTranscriptView();
	const view = useMemo(
		() => invocationView(toolName, input),
		[toolName, input],
	);
	const json = useMemo(() => {
		if (view.kind !== "json" && view.kind !== "params") return "";
		try {
			return JSON.stringify(input, null, 2);
		} catch {
			return String(input);
		}
	}, [view.kind, input]);
	const jsonLines = useMemo(() => outputLineCount(json), [json]);
	const label = invocationLabel(view);

	switch (view.kind) {
		// The plan is the whole of what is being asked, so it stands without a
		// label.
		case "plan":
			return (
				<ClampedContent budget="main" name="plan" view={transcriptView}>
					<MarkdownContent content={view.plan} />
				</ClampedContent>
			);

		case "command":
			return (
				<Section
					label={label}
					copyText={view.command}
					collapsible={collapsible}
				>
					{view.description && (
						<p className="mb-1 text-th-text-muted">{view.description}</p>
					)}
					<CodeHighlighter
						language="bash"
						wrap
						copyable={false}
						// Shiki tokenizes on the main thread, so an argument past the
						// viewer's own ceiling is shown as plain text rather than
						// freezing the transcript.
						plain={view.command.length > HIGHLIGHT_LIMIT}
					>
						{view.command}
					</CodeHighlighter>
					{view.cwd && !isSameNativePath(view.cwd, workDir) && (
						<p className="break-all text-th-text-muted">
							in <span className="font-mono">{view.cwd}</span>
						</p>
					)}
				</Section>
			);

		case "search":
			return (
				<Section label={label} collapsible={collapsible}>
					<FieldList entries={view.entries} />
				</Section>
			);

		// Copied as JSON: what goes on the clipboard is pasted back into a
		// tool or a script, and the list is only how it reads here.
		case "params":
			return (
				<Section label={label} copyText={json} collapsible={collapsible}>
					<FieldList entries={view.entries} />
				</Section>
			);

		case "todos":
			return (
				// Never cut: the list is short, and every item on it is the point.
				<Section label={label} collapsible={collapsible} budget="none">
					<TodoChecklist todos={view.todos} />
				</Section>
			);

		// One file is one line — the path, Open, copy — and no `File` header
		// over it: the header only said what the path plainly is, and on a
		// phone it and the path's own line cost a screen's worth of a diff. The
		// group keeps the name for a screen reader. Several files, or one folded
		// under a result, keep the header that lists or folds them.
		case "paths":
			if (view.paths.length === 1 && !collapsible) {
				return (
					// biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; this is a labelled group of a line and its actions
					<div role="group" aria-label={label}>
						<PathLine path={view.paths[0]} onOpenFile={onOpenFile} copyable />
					</div>
				);
			}
			return (
				<Section
					label={label}
					copyText={view.paths.join("\n")}
					collapsible={collapsible}
					count={{ noun: "file", total: view.paths.length }}
				>
					{view.paths.map((path) => (
						<PathLine key={path} path={path} onOpenFile={onOpenFile} />
					))}
				</Section>
			);

		case "text":
			return (
				<Section label={label} collapsible={collapsible}>
					<p className="whitespace-pre-wrap text-th-text-primary">
						{view.text}
					</p>
				</Section>
			);

		case "json":
			return (
				<Section
					label={label}
					copyText={json}
					collapsible={collapsible}
					count={{ noun: "line", total: jsonLines }}
				>
					<CodeHighlighter
						language="json"
						wrap
						copyable={false}
						plain={json.length > HIGHLIGHT_LIMIT}
					>
						{json}
					</CodeHighlighter>
				</Section>
			);
	}
}
