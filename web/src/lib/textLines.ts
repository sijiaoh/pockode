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
