import { createPatch } from "diff";
import { WrapText } from "lucide-react";
import type { ReactNode } from "react";
import {
	type CodexChangeView,
	parseCodexChanges,
} from "../../lib/codexChanges";
import {
	diffSettingsActions,
	useDiffSettingsStore,
} from "../../lib/diffSettingsStore";
import { diffStat } from "../../lib/diffStat";
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
 *
 * An `Edit` and a `MultiEdit` are both a file's patches, built here once:
 * the header counts their lines and the body draws them.
 */
export type ProposedChangeData =
	| { kind: "diff"; filePath: string; patches: string[] }
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
 * By input, because a call's input never changes and three places ask about
 * the same one: the result, its header and its copy button.
 */
const changeCache = new WeakMap<
	object,
	{ toolName: string; change: ProposedChangeData | null }
>();

/**
 * Null for a tool that changes no file, or an input of the wrong shape.
 * Remembered per input: a Codex payload's add and delete patches diff whole
 * files, and an edit's patch is a diff too.
 */
export function proposedChange(
	toolName: string,
	input: unknown,
): ProposedChangeData | null {
	if (typeof input !== "object" || input === null) return null;
	const cached = changeCache.get(input);
	if (cached?.toolName === toolName) return cached.change;
	const change = buildProposedChange(toolName, input);
	changeCache.set(input, { toolName, change });
	return change;
}

function buildProposedChange(
	toolName: string,
	input: unknown,
): ProposedChangeData | null {
	switch (toolName) {
		case "Edit": {
			if (isEditInput(input)) {
				return {
					kind: "diff",
					filePath: input.file_path,
					patches: [
						createPatch(input.file_path, input.old_string, input.new_string),
					],
				};
			}
			const changes = parseCodexChanges(input);
			return changes ? { kind: "codex", changes } : null;
		}
		case "MultiEdit":
			return isMultiEditInput(input)
				? {
						kind: "diff",
						filePath: input.file_path,
						patches: input.edits.map((edit) =>
							createPatch(input.file_path, edit.old_string, edit.new_string),
						),
					}
				: null;
		case "Write":
			return isWriteInput(input) ? { kind: "write", input } : null;
		default:
			return null;
	}
}

/** The change as text to copy, where it is text: a new file is its content. */
export function proposedChangeText(
	change: ProposedChangeData,
): string | undefined {
	return change.kind === "write" ? change.input.content : undefined;
}

function changePatches(change: ProposedChangeData): string[] | undefined {
	switch (change.kind) {
		case "diff":
			return change.patches;
		case "codex":
			return change.changes.flatMap((c) => (c.patch ? [c.patch] : []));
		case "write":
			return undefined;
	}
}

/**
 * What a change's header says and offers: how many lines it adds and removes,
 * and a switch to wrap long lines. Nothing for a new file, which is content
 * rather than a diff — every line of it would count as added, overwritten or
 * not.
 */
export function proposedChangeHeader(change: ProposedChangeData | null): {
	meta?: ReactNode;
	actions?: ReactNode;
} {
	const patches = change && changePatches(change);
	// A Codex change of hunkless files only (an empty add, a pure rename) has
	// nothing to count and nothing to wrap.
	if (!patches?.length) return {};
	const { added, removed } = diffStat(patches);
	return {
		meta: (
			<span className="font-mono">
				<span className="text-th-success">+{added}</span>{" "}
				<span className="text-th-error">−{removed}</span>
			</span>
		),
		actions: <WrapLinesToggle />,
	};
}

function WrapLinesToggle() {
	const wrap = useDiffSettingsStore((s) => s.wrapLines);
	return (
		<button
			type="button"
			aria-label="Wrap long lines"
			aria-pressed={wrap}
			onClick={diffSettingsActions.toggleWrapLines}
			className={`touch-target flex size-6 items-center justify-center rounded hover:bg-th-overlay-hover hover:text-th-text-primary ${
				wrap ? "bg-th-bg-tertiary text-th-text-primary" : "text-th-text-muted"
			}`}
		>
			<WrapText size={14} aria-hidden="true" />
		</button>
	);
}

function PatchList({
	fileName,
	patches,
}: {
	fileName: string;
	patches: string[];
}) {
	const wrap = useDiffSettingsStore((s) => s.wrapLines);
	return (
		<div className="space-y-2">
			{patches.map((patch, index) => (
				<DiffViewer
					// biome-ignore lint/suspicious/noArrayIndexKey: an input's patches are fixed
					key={index}
					fileName={fileName}
					hunks={[patch]}
					wrap={wrap}
				/>
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
						<PatchList fileName={change.newPath} patches={[change.patch]} />
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
		case "diff":
			return <PatchList fileName={change.filePath} patches={change.patches} />;
		case "write":
			return (
				// Its copy button is the block header's (`proposedChangeText`).
				<FileContentDisplay
					content={change.input.content}
					filePath={change.input.file_path}
					copyable={false}
				/>
			);
		case "codex":
			return <CodexDiff changes={change.changes} />;
	}
}
