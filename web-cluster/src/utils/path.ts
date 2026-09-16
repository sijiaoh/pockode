/**
 * Last segment of a filesystem path, accepting either separator.
 *
 * A node path is typed by the user and names a directory on the node's own
 * machine, so it is in that machine's native form — backslash-separated on
 * Windows. This mirrors what the server derives a node name with
 * (`filepath.Base`), so the placeholder matches the name actually assigned.
 */
export function baseName(path: string): string {
	return path.split(/[/\\]/).filter(Boolean).pop() ?? "";
}

/**
 * Splits a path into everything-but-the-last-segment and the last segment.
 *
 * Card paths are truncated in the middle: the head repeats across every node on
 * a machine while the tail is what tells two projects apart, so ordinary CSS
 * truncation hides the only part worth reading. Rendering the two halves as
 * separate spans — a shrinking head and a held-back tail — lets the browser
 * decide where the cut falls from the real available width, which a character
 * budget here could only guess at.
 *
 * The separator stays with the tail so the two spans concatenate back to the
 * input, and so a truncated head reads as `~/pro…/my-app` rather than
 * `~/pro…my-app`.
 */
export function splitTail(path: string): { head: string; tail: string } {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	// No separator, or a trailing one with nothing after it: there is no tail to
	// protect, so the whole string stays in the head and truncates normally.
	if (cut <= 0 || cut === path.length - 1) return { head: path, tail: "" };
	return { head: path.slice(0, cut), tail: path.slice(cut) };
}

/**
 * Collapses the user's home directory to `~`.
 *
 * The prefix is guessed from the shape of the path rather than known: the path
 * describes the node's machine, not the browser's, so there is nothing to read
 * it from. A wrong guess only costs display width.
 */
export function displayPath(path: string): string {
	return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}
