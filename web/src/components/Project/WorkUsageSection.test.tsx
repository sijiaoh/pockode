import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../../types/message";
import type { WorkUsage } from "../../types/work";
import WorkUsageSection from "./WorkUsageSection";

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		...overrides,
	};
}

function renderSection(usage: WorkUsage, type: "story" | "task" = "story") {
	return render(<WorkUsageSection type={type} usage={usage} />);
}

describe("WorkUsageSection", () => {
	it("shows nothing when neither the story nor its tasks reported anything", () => {
		const { container } = renderSection({ task_count: 3 });

		expect(container).toBeEmptyDOMElement();
	});

	it("shows one figure and no column headers when there are no tasks", () => {
		renderSection({
			own: tokens({ input_tokens: 124_000, cost_usd: 0.42 }),
			total: tokens({ input_tokens: 124_000, cost_usd: 0.42 }),
			task_count: 0,
		});

		expect(screen.getByText("124K")).toBeInTheDocument();
		expect(screen.getByText("$0.42")).toBeInTheDocument();
		expect(screen.queryByText("This story")).not.toBeInTheDocument();
		expect(screen.queryByText(/Total covers/)).not.toBeInTheDocument();
	});

	it("names both columns and the count behind the total", () => {
		renderSection({
			own: tokens({ input_tokens: 124_000, cost_usd: 0.42 }),
			total: tokens({ input_tokens: 1_200_000, cost_usd: 3.87 }),
			task_count: 5,
		});

		expect(screen.getByText("This story")).toBeInTheDocument();
		expect(screen.getByText("Incl. 5 tasks")).toBeInTheDocument();
		expect(screen.getByText("124K")).toBeInTheDocument();
		expect(screen.getByText("1.2M")).toBeInTheDocument();
		expect(screen.getByText("$0.42")).toBeInTheDocument();
		expect(screen.getByText("$3.87")).toBeInTheDocument();
		expect(
			screen.getByText("Total covers this story and every task beneath it."),
		).toBeInTheDocument();
	});

	// The column is named after what the user is looking at, so a task's own
	// figure is not labelled as a story's.
	it("names the own column after the work item's type", () => {
		renderSection(
			{
				own: tokens({ input_tokens: 10 }),
				total: tokens({ input_tokens: 20 }),
				task_count: 1,
			},
			"task",
		);

		expect(screen.getByText("This task")).toBeInTheDocument();
		expect(screen.getByText("Incl. 1 task")).toBeInTheDocument();
	});

	// Both columns show because the story has tasks, not because the numbers
	// differ: a story whose tasks have not spent anything still shows both.
	it("keeps both columns when the figures are equal", () => {
		renderSection({
			own: tokens({ input_tokens: 500 }),
			total: tokens({ input_tokens: 500 }),
			task_count: 2,
		});

		expect(screen.getByText("This story")).toBeInTheDocument();
		expect(screen.getAllByText("500")).toHaveLength(2);
	});

	it("says a missing figure was not reported instead of showing a zero", () => {
		renderSection({
			total: tokens({ input_tokens: 1_200_000, cost_usd: 3.87 }),
			task_count: 5,
		});

		expect(screen.getAllByText("not reported")).toHaveLength(2);
		expect(screen.queryByText("0")).not.toBeInTheDocument();
		expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
	});

	it("drops the cost row when nothing under the item reported a price", () => {
		renderSection({
			own: tokens({ input_tokens: 1_000 }),
			total: tokens({ input_tokens: 2_000 }),
			task_count: 1,
		});

		expect(screen.getByText("Tokens")).toBeInTheDocument();
		expect(screen.queryByText("Cost")).not.toBeInTheDocument();
		expect(screen.queryByText("not reported")).not.toBeInTheDocument();
	});

	it("keeps the cost row with a dash where only the tasks reported a price", () => {
		renderSection({
			own: tokens({ input_tokens: 1_000 }),
			total: tokens({ input_tokens: 2_000, cost_usd: 3.87 }),
			task_count: 1,
		});

		expect(screen.getByText("$3.87")).toBeInTheDocument();
		expect(screen.getAllByText("not reported")).toHaveLength(1);
	});

	// A tree mixing an agent that prices with one that never does must not print
	// a figure that looks complete.
	it("marks the total cost as a floor when sessions reported no price", () => {
		renderSection({
			own: tokens({ input_tokens: 1_000, cost_usd: 0.42 }),
			total: tokens({ input_tokens: 2_000, cost_usd: 3.87 }),
			task_count: 4,
			unpriced_session_count: 2,
		});

		expect(screen.getByText("$3.87+")).toBeInTheDocument();
		expect(screen.getByText("$0.42")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Price is missing for 2 sessions — their agent does not report one.",
			),
		).toBeInTheDocument();
	});

	// The sentence explains the `+` on a cost figure; with no cost row it would
	// point at something that is not on screen.
	it("keeps the missing-price note out when there is no cost row to qualify", () => {
		renderSection({
			own: tokens({ input_tokens: 1_000 }),
			total: tokens({ input_tokens: 2_000 }),
			task_count: 4,
			unpriced_session_count: 2,
		});

		expect(screen.queryByText("Cost")).not.toBeInTheDocument();
		expect(screen.queryByText(/Price is missing/)).not.toBeInTheDocument();
	});

	it("sums the four counters into the headline figure", () => {
		renderSection({
			own: tokens({
				input_tokens: 400,
				output_tokens: 100,
				cache_read_tokens: 400,
				cache_write_tokens: 100,
			}),
			total: tokens({ input_tokens: 1_000 }),
			task_count: 1,
		});

		expect(screen.getAllByText("1K")).toHaveLength(2);
	});
});
