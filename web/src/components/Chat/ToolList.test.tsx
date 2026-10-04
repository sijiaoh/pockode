import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ContentPart } from "../../types/message";
import ThinkingItem from "./ThinkingItem";
import { PartBlocks } from "./ToolList";
import { OpenedThoughtsContext } from "./turnTailContext";

const bash = (id: string): ContentPart => ({
	type: "tool_call",
	tool: { id, name: "Bash", input: { command: id }, status: "success" },
});

const parts: ContentPart[] = [
	{
		type: "thinking",
		id: "th-1",
		thoughts: [
			{
				content: "Plan it.",
				fullReasoning: "",
				redacted: false,
				durationMs: 2000,
			},
		],
	},
	bash("a"),
	bash("b"),
];

function List() {
	return (
		<PartBlocks
			items={parts.map((part, index) => ({ part, index }))}
			renderPart={({ part }) =>
				part.type === "thinking" ? (
					<ThinkingItem thoughts={part.thoughts} />
				) : (
					<span>{part.type === "tool_call" ? part.tool.id : ""}</span>
				)
			}
		/>
	);
}

describe("PartBlocks with thinking", () => {
	// Nothing closes what the user opened: the row they are reading stays in
	// sight when its group folds over it.
	it("folds a thinking into its group, and keeps one the user opened", async () => {
		const user = userEvent.setup();
		render(<List />);
		const summary = screen.getByRole("button", {
			name: /^doneRan 2 commands·Thought for 2s$/,
		});
		expect(
			screen.queryByRole("button", { name: "Thought for 2 seconds" }),
		).not.toBeInTheDocument();

		await user.click(summary);
		await user.click(
			screen.getByRole("button", { name: "Thought for 2 seconds" }),
		);
		await user.click(summary);

		expect(
			screen.getByRole("button", { name: "Thought for 2 seconds" }),
		).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("a")).not.toBeVisible();
	});

	// The user opened it while it was still the tail line, before the row
	// existed: it settles open and in sight, though its group has folded.
	it("opens a thinking that settled from a tail line the user had open", () => {
		render(
			<OpenedThoughtsContext value={new Set(["th-1"])}>
				<List />
			</OpenedThoughtsContext>,
		);

		expect(
			screen.getByRole("button", { name: "Thought for 2 seconds" }),
		).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("a")).not.toBeVisible();
	});
});
