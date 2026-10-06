export interface DiffStat {
	added: number;
	removed: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Lines added and removed across unified diffs.
 *
 * Each hunk is read by the line counts in its header rather than by prefix
 * alone: a removed line reading `-- note` is `--- note` in the patch, which a
 * prefix test cannot tell from a file header. A count left out of the header
 * means one line, as in the format itself.
 */
export function diffStat(patches: string[]): DiffStat {
	let added = 0;
	let removed = 0;
	for (const patch of patches) {
		let oldLeft = 0;
		let newLeft = 0;
		for (const line of patch.split("\n")) {
			if (oldLeft > 0 || newLeft > 0) {
				if (line.startsWith("+")) {
					added++;
					newLeft--;
				} else if (line.startsWith("-")) {
					removed++;
					oldLeft--;
				} else if (!line.startsWith("\\")) {
					// Context; "\ No newline at end of file" belongs to neither side.
					oldLeft--;
					newLeft--;
				}
				continue;
			}
			const header = HUNK_HEADER.exec(line);
			if (header) {
				oldLeft = header[1] === undefined ? 1 : Number(header[1]);
				newLeft = header[2] === undefined ? 1 : Number(header[2]);
			}
		}
	}
	return { added, removed };
}
