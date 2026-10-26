import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileSearchState } from "../../hooks/useFileSearch";
import type {
	FileSearchResult,
	SearchLine,
	SearchRange,
} from "../../types/search";
import FileSearchResults from "./FileSearchResults";

function line(
	number: number,
	text: string,
	ranges: SearchRange[] = [],
	rank = 0,
): SearchLine {
	return { number, text, ranges, rank };
}

function marked(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll("mark"), (m) => m.textContent);
}

function renderResults(
	result: FileSearchResult,
	overrides: Partial<FileSearchState> = {},
) {
	const search: FileSearchState = {
		status: "ready",
		result,
		error: null,
		isFetching: false,
		mode: "content",
		minQueryLength: 3,
		matchedQuery: "needle",
		retry: vi.fn(),
		...overrides,
	};

	return render(
		<FileSearchResults
			search={search}
			onSelectFile={vi.fn()}
			activeFilePath={null}
		/>,
	);
}

describe("FileSearchResults in content mode", () => {
	it("previews the best-ranked matches in line order and summarises the rest", () => {
		renderResults({
			matches: [
				{
					path: "src/app.ts",
					name: "app.ts",
					// The file's best line is its last one, the case where showing the
					// first lines would hide what ranked the file.
					lines: [
						line(3, "const needle = 1;", [], 3),
						line(9, "use(needle);", [], 1),
						line(12, "// needle", [], 2),
						line(20, "needle again", [], 4),
						line(31, "still needle", [], 0),
					],
				},
			],
			truncated: false,
		});

		expect(
			screen
				.getAllByRole("button", { name: /match on line/ })
				.map((button) => button.getAttribute("aria-label")),
		).toEqual([
			"Open src/app.ts, match on line 9",
			"Open src/app.ts, match on line 12",
			"Open src/app.ts, match on line 31",
		]);
		expect(screen.getByText("+2 more matches")).toBeInTheDocument();
		expect(screen.getByText("1 file · 5 matches")).toBeInTheDocument();
	});

	it("lists files in the order the server ranked them", () => {
		renderResults({
			matches: [
				{ path: "src/z.ts", name: "z.ts", lines: [line(40, "needle")] },
				{ path: "src/a.ts", name: "a.ts", lines: [line(2, "nee dle")] },
			],
			truncated: false,
		});

		// Neither alphabetical nor by line number: the best-scoring file first.
		expect(
			screen
				.getAllByRole("button", { name: /match on line/ })
				.map((button) => button.getAttribute("aria-label")),
		).toEqual([
			"Open src/z.ts, match on line 40",
			"Open src/a.ts, match on line 2",
		]);
	});

	it("says the search was cut off rather than claiming nothing matches", () => {
		renderResults({ matches: [], truncated: true });

		expect(
			screen.getByText(/Search stopped before it finished/),
		).toBeInTheDocument();
		// Widening the scan is the wrong advice for a search that already ran out
		// of budget, so the usual remedies must stay away.
		expect(
			screen.queryByRole("button", { name: "Search ignored files too" }),
		).not.toBeInTheDocument();
	});

	it("warns when the server truncated the results", () => {
		renderResults({
			matches: [{ path: "src/app.ts", name: "app.ts", lines: [line(1, "x")] }],
			truncated: true,
		});

		// Counting what arrived stays useful even when more exists — one file over
		// the per-file line cap is enough to set the flag on an otherwise complete
		// result, so the warning must not swallow the summary.
		expect(
			screen.getByText("1 file · 1 match · more results exist"),
		).toBeInTheDocument();
		expect(screen.getByText(/refine your search/)).toBeInTheDocument();
	});
});

describe("FileSearchResults highlighting", () => {
	it("marks the characters the server matched in content mode", () => {
		const { container } = renderResults({
			matches: [
				{
					path: "src/app.ts",
					name: "app.ts",
					// The query is not what decides the marks: these ranges do.
					lines: [line(3, "\tconst Needle = needle;", [{ start: 7, end: 13 }])],
				},
			],
			truncated: false,
		});

		expect(marked(container)).toEqual(["Needle"]);
	});

	it("marks each part of a fuzzy content match separately", () => {
		const { container } = renderResults(
			{
				matches: [
					{
						path: "src/search.go",
						name: "search.go",
						// "srch tmout": the characters picked are scattered, and the
						// two terms meet at "hT" so the server merged across them.
						lines: [
							line(7, "\tsearchTimeout = 10 * time.Second", [
								{ start: 1, end: 2 },
								{ start: 4, end: 8 },
								{ start: 9, end: 10 },
								{ start: 11, end: 14 },
							]),
						],
					},
				],
				truncated: false,
			},
			{ matchedQuery: "srch tmout" },
		);

		expect(marked(container)).toEqual(["s", "rchT", "m", "out"]);
		expect(container).toHaveTextContent("searchTimeout = 10 * time.Second");
	});

	it("marks a fuzzy name match in both the file name and its directory", () => {
		const { container } = renderResults(
			{
				matches: [
					{
						path: "src/hooks/useFileSearch.ts",
						name: "useFileSearch.ts",
						// "h/us": a range that runs across the "/" is split between the
						// directory and the file name.
						path_ranges: [
							{ start: 4, end: 5 },
							{ start: 9, end: 12 },
						],
					},
				],
				truncated: false,
			},
			{ mode: "name", minQueryLength: 1, matchedQuery: "h/us" },
		);

		// The file name is the row's title, drawn above its directory.
		expect(marked(container)).toEqual(["us", "h", "/"]);
		expect(container).toHaveTextContent("useFileSearch.ts");
		expect(container).toHaveTextContent("src/hooks/");
	});

	it("marks nothing when the server sent no ranges", () => {
		const { container } = renderResults(
			{
				matches: [{ path: "src/test.ts", name: "test.ts" }],
				truncated: false,
			},
			{ mode: "name", minQueryLength: 1, matchedQuery: "!spec" },
		);

		expect(container.querySelector("mark")).toBeNull();
		expect(container).toHaveTextContent("test.ts");
	});
});
