import { createPatch } from "diff";
import { type CodexChangeView, parseCodexChanges } from "./codexChanges";
import { outputLineCount } from "./textLines";

export interface EditInput {
	file_path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export interface WriteInput {
	file_path: string;
	content: string;
}

export interface MultiEditInput {
	file_path: string;
	edits: Array<{
		old_string: string;
		new_string: string;
		replace_all?: boolean;
	}>;
}

/**
 * What a file tool will do to the file, read from its input alone.
 *
 * Nothing here reads the result, which is what lets the same reading serve
 * three places: a finished call's result, the permission card asking whether
 * the call may run at all — so what was approved and what ran read the same —
 * and a turn's tally of what it changed (`turnChanges`).
 *
 * An `Edit`'s and a `MultiEdit`'s patches are built here once: the header
 * counts their lines and the body draws them.
 */
export type ProposedChangeData =
	| { kind: "edit"; input: EditInput; patches: string[] }
	| { kind: "multiEdit"; input: MultiEditInput; patches: string[] }
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
	return (
		typeof i?.file_path === "string" &&
		Array.isArray(i?.edits) &&
		i.edits.every((edit) => {
			const e = edit as Record<string, unknown>;
			return (
				typeof e?.old_string === "string" && typeof e?.new_string === "string"
			);
		})
	);
}

/**
 * By input, because a call's input never changes and several places ask about
 * the same one: the result, its header, its copy button and the turn's tally.
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
					kind: "edit",
					input,
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
						kind: "multiEdit",
						input,
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

export function changePatches(
	change: ProposedChangeData,
): string[] | undefined {
	switch (change.kind) {
		case "edit":
		case "multiEdit":
			return change.patches;
		case "codex":
			return change.changes.flatMap((c) => (c.patch ? [c.patch] : []));
		case "write":
			return undefined;
	}
}

/**
 * The rows a patch is drawn in: its hunk headers and lines, without the file
 * headers the viewer leaves out.
 */
export function patchRows(patch: string): number {
	let rows = 0;
	// The file headers are the lines before the first hunk; inside one, a
	// line reading `---` is a removed `--` line, and is drawn.
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) inHunk = true;
		if (inHunk && /^[ +\-@]/.test(line)) rows++;
	}
	return rows;
}

/**
 * The rows the change is drawn in, for counting what a cut hides: a new
 * file's lines, or its patches' rows.
 */
export function changeRowCount(change: ProposedChangeData): number {
	const patches = changePatches(change);
	if (!patches) {
		return change.kind === "write" ? outputLineCount(change.input.content) : 0;
	}
	return patches.reduce((rows, patch) => rows + patchRows(patch), 0);
}
