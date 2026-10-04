import { useMemo } from "react";
import { codexChangePaths } from "../../lib/codexChanges";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { useWSStore } from "../../lib/wsStore";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { relativeToWorkDir } from "../../utils/path";
import { MarkdownContent } from "../ui";
import { Section } from "./ToolOutcomeSections";

/** A path in full, with the way over to the Files tab when there is one. */
export function PathLine({
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

function trimSeparators(path: string): string {
	return path.replace(/[\\/]+$/, "");
}

/**
 * How a call's input is drawn. `json` is the input verbatim; every other kind
 * is a reading of it, which is what tells the permission card whether the raw
 * input still has anything to add.
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

	return { kind: "json" };
}

/**
 * What the agent asked for, in full — the answer to a row that truncated it,
 * and the body of the permission card that asks whether it may run.
 *
 * Always present on a tool row, which is what makes the chevron unconditional:
 * before this section existed a running call and a call that answered with an
 * image alone could not be opened at all.
 *
 * Only the command and the JSON fallback wrap: a command is read end to end
 * before it is approved, while a diff or a file reads by its lines and keeps its
 * own viewer's horizontal scroll.
 */
export function ToolInvocation({
	toolName,
	input,
	onOpenFile,
}: {
	toolName: string;
	input: unknown;
	onOpenFile?: (path: string) => void;
}) {
	const workDir = useWSStore((state) => state.workDir);
	const view = useMemo(
		() => invocationView(toolName, input),
		[toolName, input],
	);
	const json = useMemo(() => {
		if (view.kind !== "json") return "";
		try {
			return JSON.stringify(input, null, 2);
		} catch {
			return String(input);
		}
	}, [view.kind, input]);

	switch (view.kind) {
		// The plan is the whole of what is being asked, so it stands without a
		// label.
		case "plan":
			return <MarkdownContent content={view.plan} />;

		case "command":
			return (
				<Section label="Invocation">
					{view.description && (
						<p className="text-th-text-muted">{view.description}</p>
					)}
					<CodeHighlighter
						language="bash"
						wrap
						// Shiki tokenizes on the main thread, so an argument past the
						// viewer's own ceiling is shown as plain text rather than
						// freezing the transcript.
						plain={view.command.length > HIGHLIGHT_LIMIT}
					>
						{view.command}
					</CodeHighlighter>
					{view.cwd && trimSeparators(view.cwd) !== trimSeparators(workDir) && (
						<p className="break-all text-th-text-muted">
							in <span className="font-mono">{view.cwd}</span>
						</p>
					)}
				</Section>
			);

		case "search":
			return (
				<Section label="Invocation">
					<dl className="space-y-0.5">
						{view.entries.map(([key, value]) => (
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

		case "paths":
			return (
				<Section label="Invocation">
					{view.paths.map((path) => (
						<PathLine key={path} path={path} onOpenFile={onOpenFile} />
					))}
				</Section>
			);

		case "text":
			return (
				<Section label="Invocation">
					<p className="whitespace-pre-wrap text-th-text-primary">
						{view.text}
					</p>
				</Section>
			);

		case "json":
			return (
				<Section label="Invocation">
					<CodeHighlighter
						language="json"
						wrap
						plain={json.length > HIGHLIGHT_LIMIT}
					>
						{json}
					</CodeHighlighter>
				</Section>
			);
	}
}
