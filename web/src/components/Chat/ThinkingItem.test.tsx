import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Thought } from "../../types/message";
import ThinkingItem from "./ThinkingItem";

const thought = (extra: Partial<Thought> = {}): Thought => ({
	content: "",
	fullReasoning: "",
	redacted: false,
	...extra,
});

describe("ThinkingItem", () => {
	it("opens on the text, named as a sentence", async () => {
		const user = userEvent.setup();
		render(
			<ThinkingItem
				thoughts={[
					thought({ content: "Check the **sender**.", durationMs: 11_200 }),
				]}
			/>,
		);
		const row = screen.getByRole("button", { name: "Thought for 12 seconds" });
		expect(row).toHaveTextContent("Thought for 12s");
		expect(screen.queryByText("sender")).not.toBeInTheDocument();

		await user.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("sender")).toBeInTheDocument();
	});

	it("labels Codex's raw reasoning only beside a summary", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<ThinkingItem
				thoughts={[thought({ content: "Summary.", fullReasoning: "Raw." })]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Thought" }));
		expect(screen.getByText("Full reasoning")).toBeInTheDocument();
		expect(screen.getByText("Raw.")).toBeInTheDocument();

		rerender(<ThinkingItem thoughts={[thought({ fullReasoning: "Raw." })]} />);
		expect(screen.getByText("Raw.")).toBeInTheDocument();
		expect(screen.queryByText("Full reasoning")).not.toBeInTheDocument();
	});

	it("keeps a redacted part's place in a merged body", async () => {
		const user = userEvent.setup();
		render(
			<ThinkingItem
				thoughts={[
					thought({ content: "First.", durationMs: 1000 }),
					thought({ redacted: true, durationMs: 1000 }),
					thought({ durationMs: 1000 }),
				]}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Thought for 3 seconds" }),
		);
		expect(screen.getByText("First.")).toBeInTheDocument();
		expect(
			screen.getByText("Hidden by the model provider."),
		).toBeInTheDocument();
	});

	it("says only Thought when a merged part was not measured", () => {
		render(
			<ThinkingItem
				thoughts={[
					thought({ content: "A.", durationMs: 1000 }),
					thought({ content: "B." }),
				]}
			/>,
		);
		expect(screen.getByRole("button", { name: "Thought" })).toBeInTheDocument();
	});

	// A row that opens on "there is nothing here" is a tap spent to learn
	// nothing, so the reason is in its name instead.
	it("draws redacted thinking as a row that is not a button", () => {
		render(
			<ThinkingItem
				thoughts={[thought({ redacted: true, durationMs: 75_000 })]}
			/>,
		);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("hidden")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Thought for 1 minute 15 seconds, content hidden by the model provider",
			),
		).toBeInTheDocument();
	});

	it("draws empty thinking without the chip", () => {
		render(<ThinkingItem thoughts={[thought({ durationMs: 400 })]} />);
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByText("hidden")).not.toBeInTheDocument();
		expect(
			screen.getByText("Thought for 1 second, no content shared"),
		).toBeInTheDocument();
	});
});
