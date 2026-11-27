import { describe, expect, it } from "vitest";
import { parseWebSearchResult, webSearchMarkdown } from "./webSearchResult";

const REMINDER =
	"REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

// The shape Claude's CLI answers a WebSearch with.
function result(...body: string[]): string {
	return [
		'Web search results for query: "EQ-Bench creative writing"',
		"",
		...body,
		"",
		REMINDER,
	].join("\n");
}

describe("parseWebSearchResult", () => {
	it("reads the links and the summary, without the reminder", () => {
		const parsed = parseWebSearchResult(
			result(
				'Links: [{"title":"Creative Writing Leaderboard","url":"https://www.llmlearner.com/rankings"},{"title":"EQ-Bench","url":"https://sophon.at/evals/eq"}]',
				"",
				"The most recent results point to **GPT-6**.",
			),
		);
		expect(parsed).toEqual({
			links: [
				{
					title: "Creative Writing Leaderboard",
					url: "https://www.llmlearner.com/rankings",
					href: "https://www.llmlearner.com/rankings",
					host: "llmlearner.com",
				},
				{
					title: "EQ-Bench",
					url: "https://sophon.at/evals/eq",
					href: "https://sophon.at/evals/eq",
					host: "sophon.at",
				},
			],
			summary: "The most recent results point to **GPT-6**.",
		});
	});

	// A second `Links:` line repeats part of the first.
	it("merges every Links line, keeping the first of each URL in order", () => {
		const parsed = parseWebSearchResult(
			result(
				'Links: [{"title":"A","url":"https://a.com/"},{"title":"B","url":"https://b.com/"}]',
				"",
				'Links: [{"title":"B again","url":"https://b.com/"},{"title":"C","url":"https://c.com/"}]',
				"",
				"Summary.",
			),
		);
		expect(parsed?.links.map((l) => l.title)).toEqual(["A", "B", "C"]);
		expect(parsed?.summary).toBe("Summary.");
	});

	it("makes links only of http and https URLs", () => {
		const parsed = parseWebSearchResult(
			result(
				'Links: [{"title":"Script","url":"javascript:alert(1)"},{"title":"Broken","url":"not a url"},{"url":"http://x.org/p"}]',
			),
		);
		expect(parsed?.links).toEqual([
			{
				title: "Script",
				url: "javascript:alert(1)",
				host: "javascript:alert(1)",
			},
			{ title: "Broken", url: "not a url", host: "not a url" },
			{
				title: "http://x.org/p",
				url: "http://x.org/p",
				href: "http://x.org/p",
				host: "x.org",
			},
		]);
	});

	it("keeps a Links line it cannot read as summary text", () => {
		const parsed = parseWebSearchResult(
			result('Links: [{"title":"A"', "", "Summary."),
		);
		expect(parsed).toEqual({
			links: [],
			summary: 'Links: [{"title":"A"\n\nSummary.',
		});
	});

	it("is null for a result not in the shape", () => {
		expect(parseWebSearchResult("Search failed: rate limited")).toBeNull();
		expect(parseWebSearchResult("")).toBeNull();
	});
});

describe("webSearchMarkdown", () => {
	it("lists every link with its host, then the summary", () => {
		const parsed = parseWebSearchResult(
			result(
				'Links: [{"title":"A [draft]","url":"https://www.a.com/x_(y)"},{"title":"Local","url":"file:///etc"}]',
				"",
				"Summary.",
			),
		);
		expect(parsed && webSearchMarkdown(parsed)).toBe(
			"- [A \\[draft\\]](<https://www.a.com/x_(y)>) `a.com`\n- Local `file:///etc`\n\nSummary.",
		);
	});

	// A title or URL that would otherwise close the link or the code span early.
	it("keeps awkward titles and URLs inside their markup", () => {
		const parsed = parseWebSearchResult(
			result(
				'Links: [{"title":"a\\nb & c","url":"https://a.com/x y>z"},{"title":"T","url":"weird:`x`"}]',
			),
		);
		expect(parsed && webSearchMarkdown(parsed)).toBe(
			"- [a b \\& c](<https://a.com/x%20y%3Ez>) `a.com`\n- T `` weird:`x` ``",
		);
	});
});
