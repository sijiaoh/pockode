import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileSearchState } from "../../hooks/useFileSearch";
import type { FileSearchResult } from "../../types/search";
import FileSearchResults from "./FileSearchResults";

function line(number: number, text: string) {
	return { number, text, ranges: [] };
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

// jsdom rendering can starve past the default 5s timeout when the suite runs
// with many workers on a loaded machine.
describe("FileSearchResults in content mode", { timeout: 20_000 }, () => {
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
