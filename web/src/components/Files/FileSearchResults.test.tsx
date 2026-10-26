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
): SearchLine {
	return { number, text, ranges };
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
		minQueryLength: 2,
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
	it("previews the first matches and summarises the rest", () => {
		renderResults({
			matches: [
				{
					path: "src/app.ts",
					name: "app.ts",
					lines: [
						line(3, "const needle = 1;"),
						line(9, "use(needle);"),
						line(12, "// needle"),
						line(20, "needle again"),
						line(31, "still needle"),
					],
				},
			],
			truncated: false,
		});

		expect(
			screen.getByRole("button", { name: "Open src/app.ts, match on line 3" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: "Open src/app.ts, match on line 20",
			}),
		).not.toBeInTheDocument();
		expect(screen.getByText("+2 more matches")).toBeInTheDocument();
		expect(screen.getByText("1 file · 5 matches")).toBeInTheDocument();
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
