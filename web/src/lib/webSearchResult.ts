/**
 * Claude's `WebSearch` result, which arrives as one string:
 *
 *     Web search results for query: "<query>"
 *
 *     Links: [{"title":"…","url":"https://…"}, …]
 *
 *     <the search tool's own answer, in Markdown>
 *
 *     REMINDER: You MUST include the sources above in your response …
 *
 * A result may carry more than one `Links:` line, the later ones repeating
 * some of the first. Measured on 376 local results.
 */

export interface WebSearchLink {
	/** The URL itself when the result gave no title. */
	title: string;
	url: string;
	/** Absent when the URL is not `http`/`https` — it is then not a link. */
	href?: string;
	/** The host without `www.`, or the raw URL when it is not a link. */
	host: string;
}

export interface WebSearchResult {
	links: WebSearchLink[];
	summary: string;
}

const HEADER = /^Web search results for query: ".*"$/;
const LINKS_PREFIX = "Links: ";
// The CLI's instruction to the model, wrapping the result rather than part
// of it — the same kind of wrapper as `<tool_use_error>`.
const REMINDER = /^REMINDER: You MUST include the sources/;

/** Null when the result is not in the shape above. */
export function parseWebSearchResult(result: string): WebSearchResult | null {
	const lines = result.split("\n");
	if (!HEADER.test(lines[0])) return null;

	const links: WebSearchLink[] = [];
	const seen = new Set<string>();
	const summary: string[] = [];
	for (const line of lines.slice(1)) {
		if (REMINDER.test(line)) continue;
		const parsed = line.startsWith(LINKS_PREFIX)
			? parseLinks(line.slice(LINKS_PREFIX.length))
			: null;
		if (!parsed) {
			summary.push(line);
			continue;
		}
		for (const link of parsed) {
			if (seen.has(link.url)) continue;
			seen.add(link.url);
			links.push(link);
		}
	}
	return { links, summary: summary.join("\n").trim() };
}

function parseLinks(json: string): WebSearchLink[] | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(value)) return null;
	const links: WebSearchLink[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return null;
		const { title, url } = item as Record<string, unknown>;
		if (typeof url !== "string") return null;
		if (title !== undefined && typeof title !== "string") return null;
		links.push(toLink(title || url, url));
	}
	return links;
}

function toLink(title: string, url: string): WebSearchLink {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { title, url, host: url };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
		return { title, url, host: url };
	// The parser's form, percent-encoded, so it can stand between `<` and `>`
	// as a Markdown link destination.
	return {
		title,
		url,
		href: parsed.href,
		host: parsed.hostname.replace(/^www\./, ""),
	};
}

/** The result as the full screen viewer reads it: every host in full. */
export function webSearchMarkdown({ links, summary }: WebSearchResult): string {
	const list = links
		.map((link) =>
			link.href
				? `- [${escapeLinkText(link.title)}](<${link.href}>) \`${link.host}\``
				: `- ${escapeLinkText(link.title)} ${codeSpan(link.url)}`,
		)
		.join("\n");
	return [list, summary].filter((part) => part.length > 0).join("\n\n");
}

function escapeLinkText(text: string): string {
	return text.replace(/\s+/g, " ").replace(/[\\[\]`*_<>&]/g, "\\$&");
}

/** A code span whose fence is longer than any run of backticks inside it. */
function codeSpan(text: string): string {
	const flat = text.replace(/\s+/g, " ");
	const longest = Math.max(
		0,
		...(flat.match(/`+/g) ?? []).map((run) => run.length),
	);
	const fence = "`".repeat(longest + 1);
	return longest > 0 ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
}
