import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ContentPart, ToolRunStatus } from "../../types/message";
import ThinkingItem from "./ThinkingItem";
import { PartBlocks } from "./ToolList";
import { OpenedThoughtsContext } from "./turnTailContext";

const bash = (id: string, status: ToolRunStatus = "success"): ContentPart => ({
	type: "tool_call",
	tool: { id, name: "Bash", input: { command: id }, status },
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

function List({ shown = parts }: { shown?: ContentPart[] }) {
	return (
		<PartBlocks
			items={shown.map((part, index) => ({ part, index }))}
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

	// Alone, a thinking is drawn bare rather than as a framed row; it is still
	// the same disclosure.
	it("opens a thinking that has no call beside it", async () => {
		const user = userEvent.setup();
		render(<List shown={parts.slice(0, 1)} />);
		const row = screen.getByRole("button", { name: "Thought for 2 seconds" });
		expect(row).toHaveTextContent("Thought for 2s");

		await user.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Plan it.")).toBeVisible();
	});
});

describe("PartBlocks group summary", () => {
	it("shows no tick while a folded call runs behind a waiting card", () => {
		render(
			<List
				shown={[
					{
						type: "tool_call",
						tool: {
							id: "a",
							name: "Read",
							input: { file_path: "/x" },
							status: "success",
						},
					},
					{
						type: "tool_call",
						tool: {
							id: "e",
							name: "Read",
							input: { file_path: "/y" },
							status: "success",
						},
					},
					bash("b", "background"),
					bash("c", "running"),
					{
						type: "permission_request",
						request: {
							requestId: "req-d",
							toolName: "Bash",
							toolInput: {},
							toolUseId: "d",
						},
						status: "pending",
					} as ContentPart,
				]}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /^1 running·Read 2 files$/ }),
		).toBeInTheDocument();
		expect(screen.queryByLabelText("done")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText("Tool calls running"),
		).not.toBeInTheDocument();
	});
});
