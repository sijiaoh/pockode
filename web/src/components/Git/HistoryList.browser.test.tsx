import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
import HistoryList from "./HistoryList";

// What jsdom cannot say: that at a phone's 300px, with more lines than the
// cap, the graph folds into four lanes and a `+N` slot and the text column
// keeps its 160px — measured, not computed (docs/git-history-ui.md#lane-cap).

/** Six branch tips, HEAD's first, all forked from one root: six lines at once. */
function wideHistory(): HistoryRow[] {
	const commits: GitCommit[] = [
		...Array.from({ length: 6 }, (_, i) => ({
			hash: `${i}`.repeat(40),
			parents: ["f".repeat(40)],
			subject: `A rather long subject for branch tip number ${i}`,
			author: "sijiaoh",
			date: new Date().toISOString(),
			refs:
				i === 0
					? [
							{ name: "HEAD", type: "head" as const },
							{ name: "feature/graph", type: "branch" as const, current: true },
						]
					: [{ name: `topic-${i}`, type: "branch" as const }],
		})),
		{
			hash: "f".repeat(40),
			parents: [],
			subject: "Root",
			author: "sijiaoh",
			date: new Date().toISOString(),
		},
	];
	const { rows } = layoutHistoryPage(
		commits,
		createHistoryGraphState({ scope: "all", defaultLine: undefined }),
		undefined,
	);
	return commits.map((commit, i) => ({ commit, graph: rows[i] }));
}

function renderAt(width: number) {
	render(
		<div
			className="flex flex-col overflow-hidden"
			style={{ width, height: 600 }}
		>
			<HistoryList
				rows={wideHistory()}
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

const rowOf = (subject: string) =>
	screen.getByText(subject).closest("li") as HTMLElement;

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
		const subject = screen.getByText(
			"A rather long subject for branch tip number 3",
		);

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
		const chip = screen.getByText("feature/graph").closest("span.rounded");
		expect(
			(chip as HTMLElement).getBoundingClientRect().width,
		).toBeLessThanOrEqual(6 * 16);
	});
});
