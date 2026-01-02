import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import type { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { AnsiUp } from "ansi_up";
import { createPatch } from "diff";
import { Check, Circle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
	CodeHighlighter,
	getDiffHighlighter,
	getIsDarkMode,
	getLanguageFromPath,
	subscribeToDarkMode,
} from "../../lib/shikiUtils";
import { parseReadResult } from "../../lib/toolResultParser";
import { MarkdownContent } from "./MarkdownContent";

// Singleton AnsiUp instance
const ansiUp = new AnsiUp();
ansiUp.use_classes = true;

interface ToolResultDisplayProps {
	toolName: string;
	toolInput: unknown;
	result: string;
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

function isMarkdownFile(filePath: string): boolean {
	const ext = filePath.split(".").pop()?.toLowerCase();
	return ext === "md" || ext === "mdx";
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
		// Fallback to plain text if parsing fails
		return <pre className="text-th-text-muted">{result}</pre>;
	}

	if (filePath && isMarkdownFile(filePath)) {
		return <MarkdownContent content={code} />;
	}

	const language = filePath ? getLanguageFromPath(filePath) : undefined;
	return <CodeHighlighter language={language}>{code}</CodeHighlighter>;
}

function EditResultDisplay({ input }: { input: EditInput }) {
	const isDark = useSyncExternalStore(subscribeToDarkMode, getIsDarkMode);
	const [highlighter, setHighlighter] = useState<Awaited<
		ReturnType<typeof getDiffViewHighlighter>
	> | null>(null);

	useEffect(() => {
		getDiffHighlighter().then(setHighlighter);
	}, []);

	const unifiedDiff = useMemo(
		() => createPatch(input.file_path, input.old_string, input.new_string),
		[input.file_path, input.old_string, input.new_string],
	);

	if (!highlighter) {
		return <div className="p-2 text-th-text-muted">Loading...</div>;
	}

	return (
		<div className="diff-view-wrapper diff-tailwindcss-wrapper">
			<DiffView
				data={{
					oldFile: { fileName: input.file_path },
					newFile: { fileName: input.file_path },
					hunks: [unifiedDiff],
				}}
				registerHighlighter={highlighter}
				diffViewMode={DiffModeEnum.Unified}
				diffViewTheme={isDark ? "dark" : "light"}
				diffViewHighlight
			/>
		</div>
	);
}

function MultiEditResultDisplay({ input }: { input: MultiEditInput }) {
	const isDark = useSyncExternalStore(subscribeToDarkMode, getIsDarkMode);
	const [highlighter, setHighlighter] = useState<Awaited<
		ReturnType<typeof getDiffViewHighlighter>
	> | null>(null);

	useEffect(() => {
		getDiffHighlighter().then(setHighlighter);
	}, []);

	const diffs = useMemo(
		() =>
			input.edits.map((edit, index) => ({
				index,
				patch: createPatch(input.file_path, edit.old_string, edit.new_string),
			})),
		[input.file_path, input.edits],
	);

	if (!highlighter) {
		return <div className="p-2 text-th-text-muted">Loading...</div>;
	}

	return (
		<div className="space-y-2">
			{diffs.map(({ index, patch }) => (
				<div key={index} className="diff-view-wrapper diff-tailwindcss-wrapper">
					<DiffView
						data={{
							oldFile: { fileName: input.file_path },
							newFile: { fileName: input.file_path },
							hunks: [patch],
						}}
						registerHighlighter={highlighter}
						diffViewMode={DiffModeEnum.Unified}
						diffViewTheme={isDark ? "dark" : "light"}
						diffViewHighlight
					/>
				</div>
			))}
		</div>
	);
}

function WriteResultDisplay({ input }: { input: WriteInput }) {
	if (isMarkdownFile(input.file_path)) {
		return <MarkdownContent content={input.content} />;
	}
	const language = getLanguageFromPath(input.file_path);
	return <CodeHighlighter language={language}>{input.content}</CodeHighlighter>;
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

function ToolResultDisplay({
	toolName,
	toolInput,
	result,
}: ToolResultDisplayProps) {
	const input = toolInput as Record<string, unknown>;
	const filePath =
		typeof input?.file_path === "string" ? input.file_path : undefined;

	switch (toolName) {
		case "Read":
			return <ReadResultDisplay result={result} filePath={filePath} />;

		case "Edit":
			if (isEditInput(toolInput)) {
				return <EditResultDisplay input={toolInput} />;
			}
			return <pre className="text-th-text-muted">{result}</pre>;

		case "MultiEdit":
			if (isMultiEditInput(toolInput)) {
				return <MultiEditResultDisplay input={toolInput} />;
			}
			return <pre className="text-th-text-muted">{result}</pre>;

		case "Write":
			if (isWriteInput(toolInput)) {
				return <WriteResultDisplay input={toolInput} />;
			}
			return <pre className="text-th-text-muted">{result}</pre>;

		case "Bash":
			return <BashResultDisplay result={result} />;

		case "TodoWrite":
			if (isTodoWriteInput(toolInput)) {
				return <TodoWriteResultDisplay input={toolInput} />;
			}
			return <pre className="text-th-text-muted">{result}</pre>;

		default:
			return <pre className="text-th-text-muted">{result}</pre>;
	}
}

export default ToolResultDisplay;
