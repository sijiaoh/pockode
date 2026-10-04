import { createPatch } from "diff";
import { useMemo } from "react";
import {
	type CodexChangeView,
	parseCodexChanges,
} from "../../lib/codexChanges";
import { useWSStore } from "../../lib/wsStore";
import { GIT_STATUS_INFO } from "../../types/git";
import { formatFilePath } from "../../utils/path";
import { DiffViewer, FileContentDisplay } from "../ui";

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

/**
 * What a file tool will do to the file, read from its input alone.
 *
 * Nothing here reads the result, which is what lets the same view sit in two
 * places: a finished call's result, and the permission card asking whether the
 * call may run at all — so what was approved and what ran read the same.
 */
export type ProposedChangeData =
	| { kind: "edit"; input: EditInput }
	| { kind: "multiEdit"; input: MultiEditInput }
	| { kind: "write"; input: WriteInput }
	| { kind: "codex"; changes: CodexChangeView[] };

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

/**
 * Null for a tool that changes no file, or an input of the wrong shape. Callers
 * memoize it: a Codex payload's add and delete patches diff whole files.
 */
export function proposedChange(
	toolName: string,
	input: unknown,
): ProposedChangeData | null {
	switch (toolName) {
		case "Edit": {
			if (isEditInput(input)) return { kind: "edit", input };
			const changes = parseCodexChanges(input);
			return changes ? { kind: "codex", changes } : null;
		}
		case "MultiEdit":
			return isMultiEditInput(input) ? { kind: "multiEdit", input } : null;
		case "Write":
			return isWriteInput(input) ? { kind: "write", input } : null;
		default:
			return null;
	}
}

function EditDiff({ input }: { input: EditInput }) {
	const unifiedDiff = useMemo(
		() => createPatch(input.file_path, input.old_string, input.new_string),
		[input.file_path, input.old_string, input.new_string],
	);

	return <DiffViewer fileName={input.file_path} hunks={[unifiedDiff]} />;
}

function MultiEditDiff({ input }: { input: MultiEditInput }) {
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

function CodexDiff({ changes }: { changes: CodexChangeView[] }) {
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

export function ProposedChange({ change }: { change: ProposedChangeData }) {
	switch (change.kind) {
		case "edit":
			return <EditDiff input={change.input} />;
		case "multiEdit":
			return <MultiEditDiff input={change.input} />;
		case "write":
			return (
				<FileContentDisplay
					content={change.input.content}
					filePath={change.input.file_path}
				/>
			);
		case "codex":
			return <CodexDiff changes={change.changes} />;
	}
}
