/** A line as the diff library numbers it: which version, and where in it. */
export interface DiffLineRef {
	side: "old" | "new";
	lineNumber: number;
}

/** One line of a hunk's body, numbered on the versions it is in. */
export interface DiffHunkLine {
	kind: "context" | "added" | "removed";
	old?: number;
	new?: number;
	/** The line without its marker. */
	text: string;
}

/** One `@@` hunk of a unified diff, as read from its header and body. */
export interface DiffHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	/** git's function context, the text after the second `@@`; empty if none. */
	context: string;
	/**
	 * The hunk's bottom row in each layout, which is where something drawn
	 * after the hunk has to hang. They differ when the hunk ends in a change:
	 * unified draws additions after removals, while split pairs them up, so
	 * the bottom row is the removal side's whenever it has more lines.
	 */
	lastRow: { unified: DiffLineRef; split: DiffLineRef };
	lines: DiffHunkLine[];
}

// The context is `[^\n]*`, not `.*`: git copies it from the source line, and
// `.` stops at `\r`, U+2028 and U+2029, any of which can be in one. A header
// that failed to match would shift every later hunk onto the next one's ID.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)$/;

/**
 * The hunks of one or more patches, in order — the order the server's
 * `hunk_ids` follow.
 *
 * A body is read by the counts in its header, as `diffStat` does: a removed
 * line `-- x` is `--- x` in the patch, and a blank context line can arrive
 * as an empty line (`diff.suppressBlankEmpty`), neither of which a prefix
 * test reads correctly.
 */
export function parseHunks(patch: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	const lines = patch.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const header = HUNK_HEADER.exec(lines[i]);
		if (!header) continue;
		const oldStart = Number(header[1]);
		const oldCount = header[2] === undefined ? 1 : Number(header[2]);
		const newStart = Number(header[3]);
		const newCount = header[4] === undefined ? 1 : Number(header[4]);

		let oldLeft = oldCount;
		let newLeft = newCount;
		let last: DiffHunkLine["kind"] = "context";
		const body: DiffHunkLine[] = [];
		// The lines of the change block since the last context line: what the
		// hunk ends on, if it ends on a change.
		let removed = 0;
		let added = 0;
		while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
			const line = lines[++i];
			if (line.startsWith("\\")) continue;
			if (line.startsWith("+")) {
				body.push({
					kind: "added",
					new: newStart + newCount - newLeft,
					text: line.slice(1),
				});
				newLeft--;
				added++;
				last = "added";
			} else if (line.startsWith("-")) {
				body.push({
					kind: "removed",
					old: oldStart + oldCount - oldLeft,
					text: line.slice(1),
				});
				oldLeft--;
				removed++;
				last = "removed";
			} else {
				body.push({
					kind: "context",
					old: oldStart + oldCount - oldLeft,
					new: newStart + newCount - newLeft,
					text: line.slice(1),
				});
				oldLeft--;
				newLeft--;
				removed = 0;
				added = 0;
				last = "context";
			}
		}

		const oldLast: DiffLineRef = {
			side: "old",
			lineNumber: oldStart + oldCount - 1,
		};
		const newLast: DiffLineRef = {
			side: "new",
			lineNumber: newStart + newCount - 1,
		};
		hunks.push({
			oldStart,
			oldCount,
			newStart,
			newCount,
			context: header[5].trim(),
			lastRow: {
				unified: last === "removed" ? oldLast : newLast,
				split: removed > added ? oldLast : newLast,
			},
			lines: body,
		});
	}
	return hunks;
}
