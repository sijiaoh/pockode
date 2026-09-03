import { createPatch } from "diff";
import type { GitFileStatus } from "../types/git";

export interface CodexChangeView {
	/** Key of the changes map: the path before the patch. Absolute. */
	path: string;
	/** Where the file ends up; differs from path only for a rename. */
	newPath: string;
	status: GitFileStatus;
	/** Unified diff for DiffViewer, or null when there is no hunk to show. */
	patch: string | null;
	/**
	 * Shown in place of the diff when patch is null. Each branch sets it for the
	 * hunkless payloads it knows about, but withHunks also drops patches no
	 * branch anticipated, so the renderer still needs its own fallback text.
	 */
	note?: string;
}

/**
 * @git-diff-view throws "Expected hunk header but reached end of diff" when a
 * patch has a file header but no hunk, and nothing in web/ catches it: the
 * router only installs a CatchBoundary when an errorComponent is configured,
 * and none is, so the throw unmounts the whole app. Captured payloads that
 * produce a hunkless patch (codex-cli 0.153.0): {"type":"add","content":""}
 * and a pure rename ({"type":"update","unified_diff":"","move_path":...}).
 *
 * `/^@@/m` cannot misfire: diff content lines always carry a ` `/`+`/`-`
 * prefix, so `@@` at line start is only ever a hunk header.
 */
function withHunks(patch: string): string | null {
	return /^@@/m.test(patch) ? patch : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function toChangeView(path: string, change: Record<string, unknown>) {
	const type = asString(change.type);

	switch (type) {
		case "add": {
			const content = asString(change.content);
			return {
				path,
				newPath: path,
				status: "A" as const,
				patch: withHunks(createPatch(path, "", content)),
				note: content === "" ? "New empty file" : undefined,
			};
		}
		case "delete": {
			const content = asString(change.content);
			return {
				path,
				newPath: path,
				status: "D" as const,
				patch: withHunks(createPatch(path, content, "")),
				note: content === "" ? "Deleted empty file" : undefined,
			};
		}
		case "update": {
			const movePath =
				typeof change.move_path === "string" ? change.move_path : null;
			const newPath = movePath ?? path;
			const unifiedDiff = asString(change.unified_diff);
			return {
				path,
				newPath,
				status: movePath ? ("R" as const) : ("M" as const),
				patch: withHunks(`--- a/${path}\n+++ b/${newPath}\n${unifiedDiff}`),
				note:
					unifiedDiff.trim() === ""
						? movePath
							? "Renamed, no content changes"
							: "No content changes"
						: undefined,
			};
		}
		default:
			// Degrade only this one file so the rest of the patch still renders.
			return {
				path,
				newPath: path,
				status: "?" as const,
				patch: null,
				note: `Unsupported change type: ${type}`,
			};
	}
}

/**
 * Recognize a Codex `codex_changes` payload and turn each change into a
 * renderable diff. Returns null when the input is not such a payload, letting
 * the caller fall back to the raw result.
 *
 * Every value must carry a string `type`: a malformed entry sends the whole
 * payload back to the fallback rather than rendering half a patch.
 */
export function parseCodexChanges(input: unknown): CodexChangeView[] | null {
	const record = asRecord(input);
	if (!record) return null;

	const changes = asRecord(record.changes);
	if (!changes) return null;

	const entries = Object.entries(changes);
	if (entries.length === 0) return null;

	const views: CodexChangeView[] = [];
	for (const [path, value] of entries) {
		const change = asRecord(value);
		if (!change || typeof change.type !== "string") return null;
		views.push(toChangeView(path, change));
	}

	return views.sort((a, b) => a.path.localeCompare(b.path));
}
