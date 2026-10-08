/**
 * Fence openers and closers, rules, and markers with nothing after them:
 * lines that are syntax, never words.
 */
const SYNTAX_ONLY_LINE = /^(`{3,}|~{3,}|(?:[-*_]\s*){3,}$|[#>*+-]+$)/;

/**
 * The first line of a markdown document as plain words, for a one-line
 * summary of it. Only the marks that would otherwise show as stray characters
 * are taken off; the caller truncates, so the whole line comes back.
 *
 * Underscores inside words are left alone: `snake_case` in a prompt is far
 * more likely than `_emphasis_`, and eating it would misquote the prompt.
 */
export function markdownExcerpt(markdown: string): string {
	for (const raw of markdown.split("\n")) {
		const line = raw.trim();
		if (!line || SYNTAX_ONLY_LINE.test(line)) continue;
		const text = line
			// Block markers: headings, quotes, list bullets and numbers.
			.replace(/^(?:>\s*)+/, "")
			.replace(/^#{1,6}\s+/, "")
			.replace(/\s+#+$/, "")
			.replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
			// Images and links keep their visible text.
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
			.replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
			.replace(/`+/g, "")
			.trim();
		if (text) return text;
	}
	return "";
}
