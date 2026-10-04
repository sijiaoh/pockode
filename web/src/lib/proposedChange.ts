import { type CodexChangeView, parseCodexChanges } from "./codexChanges";

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
