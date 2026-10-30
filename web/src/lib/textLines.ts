export function outputLines(text: string): string[] {
	return text.replace(/\n+$/, "").split("\n");
}

/**
 * Lines in a text, not counting the newlines it ends with. Counted without
 * splitting: it is asked of whole logs on every render that draws one.
 */
export function outputLineCount(text: string): number {
	let end = text.length;
	while (end > 0 && text[end - 1] === "\n") end--;
	let n = 1;
	for (let i = text.indexOf("\n"); i !== -1 && i < end; ) {
		n++;
		i = text.indexOf("\n", i + 1);
	}
	return n;
}

/**
 * Rows a whole file draws, for a line-number gutter that has to end on the
 * file's last row. Unlike `outputLineCount` only one trailing newline is
 * dropped: it ends the last line, while a log's trailing newlines are noise —
 * a file's `"a\n\n"` has a blank second line, and both shiki and a `<pre>`
 * draw it. CRLF counts the same, since shiki splits on `\r?\n`.
 */
export function fileLineCount(text: string): number {
	let n = 1;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		n++;
	}
	return text.endsWith("\n") ? n - 1 : n;
}
