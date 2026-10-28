import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { HistoryRow } from "../../hooks/useHistoryGraph";
import {
	createHistoryGraphState,
	LANE_WIDTH,
	layoutHistoryPage,
	MIN_TEXT_WIDTH,
	OVERFLOW_WIDTH,
	ROW_HEIGHT,
} from "../../lib/commitHistory";
import type { GitCommit } from "../../types/git";
import { formatDateTime } from "../../utils/dateTime";
import HistoryList from "./HistoryList";

// What jsdom cannot say: that at a phone's 300px, with more lines than the
// cap, the graph folds into four lanes and a `+N` slot and the text column
// keeps its 160px — measured, not computed (docs/git-history-ui.md#lane-cap);
// and that a row is laid out by the list's own width, two lines below
// `--container-git-commit-row` and one line with aligned columns from it on.

/** One instant for every commit, so a row's `title`s can be computed here. */
const DATE = new Date().toISOString();
const LONG_AUTHOR = "An author with a name too long for its column";
const authorOf = (tip: number) => (tip === 1 ? LONG_AUTHOR : "sijiaoh");
const subjectOfTip = (tip: number) =>
	`A rather long subject for branch tip number ${tip}`;

/** Branch tips, HEAD's first, all forked from one root: one line each at once. */
function wideHistory(
	tips = 6,
	headRefs: GitCommit["refs"] = [
		{ name: "HEAD", type: "head" },
		{ name: "feature/graph", type: "branch", current: true },
	],
): HistoryRow[] {
	const commits: GitCommit[] = [
		...Array.from({ length: tips }, (_, i) => ({
			hash: `${i}`.repeat(40),
			parents: ["f".repeat(40)],
			subject: subjectOfTip(i),
			author: authorOf(i),
			date: DATE,
			refs:
				i === 0 ? headRefs : [{ name: `topic-${i}`, type: "branch" as const }],
		})),
		{
			hash: "f".repeat(40),
			parents: [],
			subject: "Root",
			author: "sijiaoh",
			date: DATE,
		},
	];
	const { rows } = layoutHistoryPage(
		commits,
		createHistoryGraphState({ scope: "all", defaultLine: undefined }),
		undefined,
	);
	return commits.map((commit, i) => ({ commit, graph: rows[i] }));
}

function renderAt(width: number, rows = wideHistory()) {
	render(
		<div
			className="flex flex-col overflow-hidden"
			style={{ width, height: 600 }}
		>
			<HistoryList
				rows={rows}
				footer={{ kind: "end", text: "Beginning of history" }}
				onLoadMore={() => {}}
				onRetry={() => {}}
				activeHash={null}
				onSelectCommit={() => {}}
				onOpenMenu={() => {}}
			/>
		</div>,
	);
}

/** The subject the row shows: each layout has its own, one of them hidden. */
const subjectOf = (subject: string) =>
	screen
		.getAllByTitle(subject)
		.find((el) => el.getClientRects().length > 0) as HTMLElement;

const rowOf = (subject: string) =>
	subjectOf(subject).closest("li") as HTMLElement;

describe("HistoryList at 300px", () => {
	it("draws four lanes and folds the rest into a +N slot", async () => {
		renderAt(300);
		const tip = rowOf("A rather long subject for branch tip number 5");
		const graph = tip.querySelector("svg") as SVGSVGElement;

		expect(graph.getBoundingClientRect().width).toBe(
			4 * LANE_WIDTH + OVERFLOW_WIDTH,
		);
		// The root row has every line converging from beyond the cap.
		const root = rowOf("Root").querySelector("svg") as SVGSVGElement;
		expect(root.textContent).toBe("+2");
	});

	it("keeps the text column at least 160px wide", () => {
		renderAt(300);
		const subject = subjectOf("A rather long subject for branch tip number 3");

		expect(subject.getBoundingClientRect().width).toBeGreaterThanOrEqual(
			MIN_TEXT_WIDTH,
		);
		// Truncated, not wrapped onto a third line.
		expect(subject.scrollWidth).toBeGreaterThan(subject.clientWidth);
	});

	it("stacks 52px rows with no gap, so lines meet from row to row", () => {
		renderAt(300);
		const first = rowOf("A rather long subject for branch tip number 0");
		const second = rowOf("A rather long subject for branch tip number 1");
		const a = first.getBoundingClientRect();
		const b = second.getBoundingClientRect();

		expect(a.height).toBe(ROW_HEIGHT);
		expect(b.top).toBe(a.bottom);
		expect(
			(first.querySelector("svg") as SVGSVGElement).getBoundingClientRect()
				.height,
		).toBe(ROW_HEIGHT);
	});

	it("shows one ref chip on a phone's text column", () => {
		renderAt(300);
		const head = rowOf("A rather long subject for branch tip number 0");

		expect(head).toHaveTextContent("feature/graph");
		const chip = head.querySelector("span.rounded") as HTMLElement;
		expect(chip).toHaveTextContent("feature/graph");
		expect(chip.getBoundingClientRect().width).toBeLessThanOrEqual(6 * 16);
	});
});

describe("HistoryList row width", () => {
	// Wider than either list, so the window would call every width here wide.
	beforeEach(async () => {
		await page.viewport(1280, 800);
	});
	afterEach(async () => {
		await page.viewport(414, 896);
	});

	const rect = (el: Element) => el.getBoundingClientRect();
	/**
	 * A tip's row, measured: the subject shown, and each wide column — absent
	 * while it is hidden — found by the full value it carries as `title`.
	 */
	function measure(tip: number) {
		const row = rowOf(subjectOfTip(tip));
		const author = authorOf(tip);
		const when = formatDateTime(DATE);
		const shown = (title: string) =>
			[...row.querySelectorAll(`[title="${CSS.escape(title)}"]`)].find(
				(el) => el.getClientRects().length > 0,
			) as HTMLElement | undefined;
		return {
			row: rect(row),
			subject: rect(subjectOf(subjectOfTip(tip))),
			// The narrow layout's "author, date" on the second line.
			byline: shown(`${author}, ${when}`),
			author: shown(author),
			date: shown(when),
			hash: shown(`${tip}`.repeat(40)),
			menu: rect(row.querySelector('button[aria-label^="Actions"]') as Element),
		};
	}

	it("is two lines in a list narrower than the threshold", () => {
		renderAt(767);
		const tip = measure(2);

		expect(tip.author).toBeUndefined();
		expect(tip.date).toBeUndefined();
		expect(tip.hash).toBeUndefined();
		expect(rect(tip.byline as Element).top).toBeGreaterThanOrEqual(
			tip.subject.bottom,
		);
		expect(tip.row.height).toBe(ROW_HEIGHT);
	});

	it("is one line from the threshold on, with author, date and hash lined up down the list", () => {
		renderAt(768);
		const a = measure(1);
		const b = measure(2);

		expect(a.byline).toBeUndefined();
		expect(a.row.height).toBe(ROW_HEIGHT);
		for (const column of ["author", "date", "hash"] as const) {
			const mine = rect(a[column] as Element);
			const theirs = rect(b[column] as Element);
			// On the subject's line, and in the same place on every row.
			expect(mine.top).toBeLessThan(a.subject.bottom);
			expect(mine.bottom).toBeGreaterThan(a.subject.top);
			expect(theirs.left).toBe(mine.left);
			expect(theirs.right).toBe(mine.right);
		}
		// The long author is cut rather than pushing the columns after it.
		const author = a.author as HTMLElement;
		expect(author.scrollWidth).toBeGreaterThan(author.clientWidth);
		expect(rect(a.hash as Element).right).toBeLessThanOrEqual(a.menu.left);
	});

	it("keeps the subject 160px beside two long chips and eight lanes", () => {
		const long = "feature/a-branch-name-long-enough-to-be-cut";
		renderAt(
			768,
			wideHistory(8, [
				{ name: long, type: "branch", current: true },
				{ name: `origin/${long}`, type: "remote" },
				{ name: "v1.2.3-release-candidate-with-a-long-name", type: "tag" },
			]),
		);
		const tip = measure(0);

		expect(tip.subject.width).toBeGreaterThanOrEqual(MIN_TEXT_WIDTH);
		// The chips gave way instead, and say their whole names under a mouse.
		const chip = screen
			.getAllByTitle(long)
			.find((el) => el.getClientRects().length > 0) as HTMLElement;
		const name = chip.querySelector(".truncate") as HTMLElement;
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		// Nothing runs into the columns, and the columns stop short of `⋯`.
		expect(tip.subject.right).toBeLessThanOrEqual(
			rect(tip.author as Element).left,
		);
		expect(rect(tip.hash as Element).right).toBeLessThanOrEqual(tip.menu.left);
	});
});
