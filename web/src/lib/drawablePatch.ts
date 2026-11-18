import { createPatch } from "diff";
import type { GitDiffData } from "../types/git";

/*
 * What `@git-diff-view` can be handed. Its parser reads one file's patch and
 * throws on anything else while rendering — "Expected hunk header but reached
 * end of diff" for a file header with no hunk, "Invalid hunk header format"
 * for a second file's `diff --git` header, which it reads as a hunk's. So
 * every patch reaches DiffViewer through one of the two functions here.
 */

/**
 * `/^@@/m` cannot misfire: diff content lines always carry a ` `/`+`/`-`
 * prefix, so `@@` at line start is only ever a hunk header. `diff --git`
 * likewise only ever starts a file's section.
 */
export function hasHunk(patch: string): boolean {
	return /^@@/m.test(patch);
}

/** git's line for a side it will not diff as text. */
export const BINARY_DIFF = /^Binary files .+ and .+ differ$/m;

function fileSectionCount(patch: string): number {
	return patch.match(/^diff --git /gm)?.length ?? 0;
}

/**
 * `patch` if the viewer can draw it — one file's, with a hunk to show — and
 * null otherwise, for the caller to say what the patch was instead.
 */
export function drawablePatch(patch: string): string | null {
	return hasHunk(patch) && fileSectionCount(patch) <= 1 ? patch : null;
}

/**
 * A git diff of one path, as one file's patch.
 *
 * git writes a path whose type changed — a file that became a symlink, or
 * the reverse — as two sections: the old one deleted, the new one added.
 * Both sides' content is here in full (a link's being its target, as git
 * stores it), so the two are diffed into one patch the viewer can draw, and
 * which every reader of `diff` — hunk bars, line selection — then sees too.
 *
 * Applied where the data arrives, so nothing downstream ever holds the
 * two-section form. Hunk IDs index the server's sections, so they go: the
 * server sends none for a type change anyway, since its hunks cannot be
 * staged one by one. Hidden whitespace is not applied to the rebuilt hunks:
 * jsdiff only trims line ends, which is not git's `-w`, and a file and the
 * link that replaced it are rarely the same text anyway.
 */
export function asOneFileDiff(data: GitDiffData, path: string): GitDiffData {
	if (data.omitted || fileSectionCount(data.diff) <= 1) return data;
	// A binary side has no text to diff; left as it is, the diff is drawn as
	// any other binary one is.
	if (BINARY_DIFF.test(data.diff)) return data;
	// The mode lines are what says the type changed, so they are kept, in the
	// form git writes a mode change in: the patch still says what changed
	// where the two contents happen to match and there is no hunk.
	const oldMode = /^deleted file mode (\d+)$/m.exec(data.diff)?.[1];
	const newMode = /^new file mode (\d+)$/m.exec(data.diff)?.[1];
	const modes =
		oldMode && newMode ? `old mode ${oldMode}\nnew mode ${newMode}\n` : "";
	// Only the hunks: the headers above are git's, not jsdiff's `Index:` ones.
	const patch = createPatch(path, data.old_content, data.new_content);
	const firstHunk = patch.indexOf("\n@@");
	const hunks = firstHunk === -1 ? "" : patch.slice(firstHunk + 1);
	return {
		diff: `diff --git a/${path} b/${path}\n${modes}--- a/${path}\n+++ b/${path}\n${hunks}`,
		old_content: data.old_content,
		new_content: data.new_content,
	};
}

const SYMLINK_MODE = "120000";

/** What a patch's header says about symlinks, for the line above the diff. */
export type SymlinkChange =
	| { kind: "symlink" }
	| { kind: "typechange"; from: "file" | "symlink"; to: "file" | "symlink" };

/**
 * Whether `patch` is a symlink's, read off git's mode lines: mode `120000`
 * is a link, whose content is its target. A side going from one mode to the
 * other is a type change — git's own two-section form or `asOneFileDiff`'s
 * rebuilt `old mode` / `new mode` pair alike. A line-start match is only
 * ever a header: content lines always start with ` `, `+`, `-` or `\`.
 */
export function symlinkChange(patch: string): SymlinkChange | null {
	const mode = (re: RegExp) => re.exec(patch)?.[1];
	const before =
		mode(/^old mode (\d+)$/m) ?? mode(/^deleted file mode (\d+)$/m);
	const after = mode(/^new mode (\d+)$/m) ?? mode(/^new file mode (\d+)$/m);
	const kindOf = (m: string) => (m === SYMLINK_MODE ? "symlink" : "file");
	if (before && after && kindOf(before) !== kindOf(after)) {
		return { kind: "typechange", from: kindOf(before), to: kindOf(after) };
	}
	const index = mode(/^index \S+ (\d+)$/m);
	return [before, after, index].includes(SYMLINK_MODE)
		? { kind: "symlink" }
		: null;
}
