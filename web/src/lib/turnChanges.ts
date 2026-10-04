import { diffLines } from "diff";
import type { GitFileStatus } from "../types/git";
import type { ContentPart, ToolRun } from "../types/message";
import { relativeToWorkDir, splitNativePath } from "../utils/path";
import type { CodexChangeView } from "./codexChanges";
import { type ProposedChangeData, proposedChange } from "./proposedChange";
import { pathParts } from "./toolSummary";

/**
 * What one turn changed on disk, per file, read off its tool calls' inputs —
 * the data behind the card that lists a turn's changes. Like `toolGroups`,
 * everything is derived from the parts as they are now, so it cannot go stale;
 * unlike it, callers memoize it, because a Codex add or delete diffs the whole
 * file (`proposedChange`).
 */

export interface LineCounts {
	added: number;
	/**
	 * Absent when the transcript does not hold it: a Write over an existing file
	 * carries the new content but not what it replaced. Summed over several
	 * edits, it is what is known — absent only when nothing is.
	 */
	removed?: number;
}

/**
 * What a turn did to a file, said from whether it existed before the turn and
 * after it. Absent for a file that was there throughout and only edited.
 */
export type TurnFileMarker = "new" | "deleted" | "renamed" | "rewritten";

/** One file as one call changed it. */
export interface FileEdit {
	/** The call that made the change: the row whose body is this diff. */
	run: ToolRun;
	/**
	 * This file's change alone, ready for `ProposedChange`. For a Codex call that
	 * changed several files it holds only this file's entry, so opening one row
	 * of the card does not show the others.
	 */
	change: ProposedChangeData;
	/** The path before the change, as the agent wrote it. */
	path: string;
	/** Where the file ends up; differs from `path` only for a rename. */
	newPath: string;
	status: GitFileStatus;
	/** A Write the result says replaced a file that was already there. */
	rewritten?: true;
	/**
	 * Null for a Codex change of a type this client does not know, which has no
	 * patch to count. A `replace_all` edit counts as one replacement: how many
	 * places matched is not in the transcript, so it can undercount.
	 */
	lines: LineCounts | null;
}

/** One file across the whole turn. */
export interface TurnFile {
	/** Where the file is at the end of the turn, as the agent wrote it. */
	path: string;
	/**
	 * The directory, relative to the work directory when inside it as the tool
	 * rows show it, without a trailing separator; empty at the work directory's
	 * root.
	 */
	dir: string;
	name: string;
	marker?: TurnFileMarker;
	/**
	 * The edits' sum, so it overcounts a line one edit added and a later one
	 * changed. Null when no edit could be counted.
	 */
	lines: LineCounts | null;
	/**
	 * Every change the turn made to this file, oldest first — under each name it
	 * had, when it was renamed.
	 */
	edits: FileEdit[];
}

export interface TurnChanges {
	/** In the order the turn first touched them. */
	files: TurnFile[];
	/** The files' sum, read as each file's is. */
	lines: LineCounts | null;
}

/** Lines a text spans; a trailing newline ends the last line, it opens none. */
function lineCount(text: string): number {
	if (text === "") return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * The lines replacing `oldText` with `newText` touches. An Edit's strings are
 * fragments, usually cut mid-file without a final newline; both are closed with
 * one so that a fragment's last line compares as a line — otherwise appending
 * a line to `a` would count as rewriting `a` too. Carriage returns are set
 * aside for the same reason: in a CRLF file the closing `\n` would differ from
 * the `\r\n` the other side's copy of that line ends with.
 */
function replacementLines(oldText: string, newText: string): LineCounts {
	// An empty `old_string` is an Edit creating the file: closing it with a
	// newline would count a removed line that was never there.
	if (oldText === "") return { added: lineCount(newText), removed: 0 };
	const counts = { added: 0, removed: 0 };
	for (const part of diffLines(`${oldText}\n`, `${newText}\n`, {
		stripTrailingCr: true,
	})) {
		if (part.added) counts.added += part.count;
		else if (part.removed) counts.removed += part.count;
	}
	return counts;
}

function sumLines(counts: (LineCounts | null)[]): LineCounts | null {
	const known = counts.filter((count) => count !== null);
	if (known.length === 0) return null;
	const total: LineCounts = { added: 0 };
	for (const { added, removed } of known) {
		total.added += added;
		if (removed !== undefined) total.removed = (total.removed ?? 0) + removed;
	}
	return total;
}

/**
 * The lines a unified diff adds and removes, read off its hunks: everything
 * before the first `@@` is file header, and a header's `+++` must not count.
 */
function patchLines(patch: string): LineCounts {
	const counts = { added: 0, removed: 0 };
	let inHunks = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) inHunks = true;
		else if (!inHunks) continue;
		else if (line.startsWith("+")) counts.added++;
		else if (line.startsWith("-")) counts.removed++;
	}
	return counts;
}

function codexEdit(run: ToolRun, view: CodexChangeView): FileEdit {
	return {
		run,
		change: { kind: "codex", changes: [view] },
		path: view.path,
		newPath: view.newPath,
		status: view.status,
		// An unknown change type is the one with no patch for a reason other
		// than having nothing in it.
		lines:
			view.status === "?"
				? null
				: view.patch
					? patchLines(view.patch)
					: { added: 0, removed: 0 },
	};
}

/**
 * Whether a Write made its file or replaced one. Only the result says, in the
 * wording measured on Claude Code 2.1.286: `File created successfully at:
 * <path>` and `The file <path> has been updated successfully.` Any other
 * wording — an older record, a CLI that rephrased it — is neither: guessing
 * wrong either way would put a false word on the card.
 */
function writeOutcome(run: ToolRun): "created" | "rewritten" | undefined {
	if (created(run)) return "created";
	if (/^The file .* has been updated/.test(run.result ?? ""))
		return "rewritten";
	return undefined;
}

/**
 * See `writeOutcome`. An Edit or MultiEdit with an empty `old_string` creates
 * its file too; no result of one has been measured, so it reads as new only
 * when it answers in the Write's words.
 */
function created(run: ToolRun): boolean {
	return run.result?.startsWith("File created successfully") ?? false;
}

/** The files one call changed, in the order its diff shows them. */
function editsOf(run: ToolRun): FileEdit[] {
	const change = proposedChange(run.name, run.input);
	if (!change) return [];
	switch (change.kind) {
		case "edit": {
			const { file_path, old_string, new_string } = change.input;
			return [
				{
					run,
					change,
					path: file_path,
					newPath: file_path,
					status: created(run) ? "A" : "M",
					lines: replacementLines(old_string, new_string),
				},
			];
		}
		case "multiEdit": {
			const { file_path, edits } = change.input;
			return [
				{
					run,
					change,
					path: file_path,
					newPath: file_path,
					status: created(run) ? "A" : "M",
					lines: sumLines(
						edits.map((edit) =>
							replacementLines(edit.old_string, edit.new_string),
						),
					),
				},
			];
		}
		case "write": {
			const outcome = writeOutcome(run);
			const added = lineCount(change.input.content);
			return [
				{
					run,
					change,
					path: change.input.file_path,
					newPath: change.input.file_path,
					...(outcome === "created"
						? { status: "A", lines: { added, removed: 0 } }
						: { status: "M", lines: { added } }),
					...(outcome === "rewritten" && { rewritten: true }),
				},
			];
		}
		case "codex":
			return change.changes.map((view) => codexEdit(run, view));
	}
}

/**
 * The calls whose changes count, in transcript order, a subagent's own calls
 * at the place of the call that ran it.
 *
 * Only a call that succeeded changed anything: a failed or denied one did not,
 * and one interrupted or still running may or may not have — claiming it did
 * would send the reader to review a change that is not there. A subagent's
 * calls are read whatever became of the subagent: what it finished stays done
 * even when it was cut short afterwards.
 */
function settledEdits(parts: ContentPart[]): FileEdit[] {
	const edits: FileEdit[] = [];
	for (const part of parts) {
		if (part.type !== "tool_call") continue;
		const { tool } = part;
		if (tool.status === "success") edits.push(...editsOf(tool));
		if (tool.children) edits.push(...settledEdits(tool.children));
	}
	return edits;
}

/**
 * What the edits did to the file between them, read from whether it existed
 * before the turn (its first edit did not create it) and after (its last did
 * not delete it). A file made and deleted within one turn reads as deleted:
 * it is still something to review. One deleted and made again was replaced
 * whole, as a rewriting Write replaces it — a later edit creating it says the
 * same, even when what deleted it was a command this list cannot see.
 */
function markerOf(edits: FileEdit[]): TurnFileMarker | undefined {
	if (edits[edits.length - 1].status === "D") return "deleted";
	if (edits[0].status === "A") return "new";
	if (edits.some((edit) => edit.status === "R")) return "renamed";
	if (
		edits.some(
			(edit, index) =>
				edit.rewritten ||
				edit.status === "D" ||
				(index > 0 && edit.status === "A"),
		)
	) {
		return "rewritten";
	}
	return undefined;
}

/**
 * The directory of `pathParts`'s head, without the separators it ends on — but
 * a root keeps it, since `C:` alone names a different place than `C:\`.
 */
function dirOf(head: string): string {
	const dir = head.replace(/[/\\]+$/, "");
	return dir === "" || dir.endsWith(":") ? head : dir;
}

/**
 * What one turn changed, per file. `parts` are one assistant message's — the
 * turn, as the transcript draws it.
 *
 * Files are matched by where they sit relative to `workDir` when inside it, so
 * one file reached by two spellings of its path is still one file, and a
 * renamed file carries its earlier edits to its new name. A path outside it is
 * matched whole, in a namespace of its own: `/etc/hosts` split into segments
 * reads exactly like `<workDir>/etc/hosts` made relative.
 */
export function turnChanges(
	parts: ContentPart[],
	workDir: string,
): TurnChanges {
	const keyOf = (path: string) => {
		const relative = relativeToWorkDir(path, workDir);
		return relative === null
			? `outside:${splitNativePath(path).join("/")}`
			: `inside:${relative}`;
	};
	const all = settledEdits(parts);
	// Kept apart from the lookup so that a renamed file keeps its place in the
	// list: re-keying a Map would move it to the end.
	const ordered: FileEdit[][] = [];
	const byKey = new Map<string, FileEdit[]>();
	for (const edit of all) {
		const from = keyOf(edit.path);
		const to = keyOf(edit.newPath);
		let edits = byKey.get(from);
		if (!edits) {
			edits = [];
			ordered.push(edits);
		}
		edits.push(edit);
		if (from === to) {
			byKey.set(from, edits);
			continue;
		}
		byKey.delete(from);
		// A rename onto a file this turn already changed: those changes are still
		// the turn's, so both files' edits become one entry, in the order made,
		// at the place of whichever of the two the turn touched first.
		const replaced = byKey.get(to);
		if (replaced) {
			edits.push(...replaced);
			edits.sort((a, b) => all.indexOf(a) - all.indexOf(b));
			const [first, second] = [
				ordered.indexOf(edits),
				ordered.indexOf(replaced),
			].sort((a, b) => a - b);
			ordered[first] = edits;
			ordered.splice(second, 1);
		}
		byKey.set(to, edits);
	}

	const files = ordered.map((edits): TurnFile => {
		const path = edits[edits.length - 1].newPath;
		const { head, tail } = pathParts(path, workDir);
		return {
			path,
			dir: dirOf(head),
			name: tail,
			marker: markerOf(edits),
			lines: sumLines(edits.map((edit) => edit.lines)),
			edits,
		};
	});
	return { files, lines: sumLines(files.map((file) => file.lines)) };
}
