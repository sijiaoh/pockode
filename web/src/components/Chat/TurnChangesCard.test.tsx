import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProposedChangeData } from "../../lib/proposedChange";
import type { AssistantMessage, ContentPart } from "../../types/message";
import MessageItem from "./MessageItem";
import { TurnChangesCard } from "./TurnChangesCard";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: "/repo" }),
}));

// The diff itself is `ProposedChange`'s to draw, and its viewer measures text
// on a canvas jsdom does not have; what the card owes is handing it each edit.
vi.mock("./ProposedChange", () => ({
	proposedChangeHeader: () => ({}),
	ProposedChange: ({ change }: { change: ProposedChangeData }) => (
		<p>
			{change.kind} diff of{" "}
			{change.kind === "codex"
				? change.changes.map((c) => c.newPath).join(", ")
				: change.input.file_path}
		</p>
	),
}));

const edit = (
	id: string,
	path: string,
	oldString: string,
	newString: string,
): ContentPart => ({
	type: "tool_call",
	tool: {
		id,
		name: "Edit",
		input: { file_path: path, old_string: oldString, new_string: newString },
		status: "success",
	},
});
const write = (id: string, path: string, content: string, result: string) =>
	({
		type: "tool_call",
		tool: {
			id,
			name: "Write",
			input: { file_path: path, content },
			status: "success",
			result,
		},
	}) satisfies ContentPart;

const card = () => screen.queryByRole("group", { name: /changed$/ });

describe("TurnChangesCard", () => {
	it("names each file by where it is and what the turn did to it", () => {
		render(
			<TurnChangesCard
				parts={[
					edit("1", "/repo/src/sender/deliver.ts", "a\nb", "c\nd\ne"),
					write(
						"2",
						"/repo/backoff.ts",
						"x\ny\n",
						"File created successfully at: /repo/backoff.ts",
					),
					write(
						"3",
						"/repo/src/config.ts",
						"z\n",
						"The file /repo/src/config.ts has been updated successfully.",
					),
				]}
			/>,
		);

		const group = card();
		expect(group).toHaveAccessibleName("3 files changed");
		expect(group).toHaveTextContent("6 lines added, 2 removed");
		// Only the rows are buttons; the header is not one.
		const rows = within(group as HTMLElement).getAllByRole("button");
		expect(rows[0]).toHaveAccessibleName(
			"deliver.ts in src/sender, 3 lines added, 2 removed",
		);
		expect(rows[1]).toHaveAccessibleName("backoff.ts, new file, 2 lines added");
		// What it replaced is unknown, so nothing is said to be removed.
		expect(rows[2]).toHaveAccessibleName(
			"config.ts in src, rewritten, 1 line written",
		);
		expect(rows).toHaveLength(3);
		expect(group).not.toHaveTextContent("−0");
	});

	it("opens a row in place onto every edit of its file, in order", async () => {
		const user = userEvent.setup();
		render(
			<TurnChangesCard
				parts={[
					edit("1", "/repo/a.ts", "one", "two"),
					edit("2", "/repo/b.ts", "x", "y"),
					edit("3", "/repo/a.ts", "two", "three"),
				]}
			/>,
		);

		const row = screen.getByRole("button", { name: /^a\.ts/ });
		expect(row).toHaveAttribute("aria-expanded", "false");
		await user.click(row);
		expect(row).toHaveAttribute("aria-expanded", "true");
		const body = document.getElementById(
			row.getAttribute("aria-controls") ?? "",
		) as HTMLElement;
		// `PathLine` names the file relative to the work directory and gives the
		// full path on a tap.
		await user.click(within(body).getByRole("button", { name: "a.ts" }));
		expect(within(body).getByText("/repo/a.ts")).toBeInTheDocument();
		expect(within(body).getAllByText("edit diff of /repo/a.ts")).toHaveLength(
			2,
		);
		expect(
			within(body)
				.getAllByText(/^\d · /)
				.map((title) => title.textContent),
		).toEqual(["1 · Edit", "2 · Edit"]);

		await user.click(row);
		expect(row).toHaveAttribute("aria-expanded", "false");
	});

	it("titles nothing when a file was edited once, and says a rewrite's past is unknown", async () => {
		const user = userEvent.setup();
		render(
			<TurnChangesCard
				parts={[
					write(
						"1",
						"/repo/a.ts",
						"x\n",
						"The file /repo/a.ts has been updated successfully.",
					),
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^a\.ts/ }));
		expect(screen.queryByText(/^\d · /)).not.toBeInTheDocument();
		expect(
			screen.getByText(/what it replaced is not in this call/),
		).toBeInTheDocument();
	});

	// The tool body's blocks, not a box of its own: a scroll box inside the
	// transcript takes the drags meant for the page on a phone.
	it("opens onto blocks that clamp themselves, as the tool body's do", async () => {
		const user = userEvent.setup();
		render(
			<TurnChangesCard
				parts={[
					edit("1", "/repo/a.ts", "one", "two"),
					write("2", "/repo/b.ts", "x\n", "File created successfully"),
				]}
			/>,
		);
		const writeText = vi.spyOn(navigator.clipboard, "writeText");

		const row = screen.getByRole("button", { name: /^a\.ts/ });
		await user.click(row);
		await user.click(screen.getByRole("button", { name: /^b\.ts/ }));
		const diff = screen.getByText("edit diff of /repo/a.ts");
		expect(screen.getByText("Change")).toBeInTheDocument();
		expect(diff.closest(".max-h-80")).toHaveClass("overflow-y-hidden");
		const group = card() as HTMLElement;
		expect(
			group.querySelector(".overflow-auto, .overflow-y-auto, [class*='60vh']"),
		).toBeNull();

		// The new file's content is copied from its block's header.
		await user.click(screen.getByRole("button", { name: "Copy content" }));
		expect(writeText).toHaveBeenLastCalledWith("x\n");
	});

	it("titles each step by the tool that made it", async () => {
		const user = userEvent.setup();
		render(
			<TurnChangesCard
				parts={[
					edit("1", "/repo/a.ts", "x", "y"),
					write(
						"2",
						"/repo/a.ts",
						"z\n",
						"The file /repo/a.ts has been updated successfully.",
					),
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^a\.ts, rewritten/ }));
		expect(
			screen.getAllByText(/^\d · /).map((title) => title.textContent),
		).toEqual(["1 · Edit", "2 · Write"]);
		// Only the Write has content to copy, and its button says which step.
		expect(
			screen.getByRole("button", { name: "Copy content of 2 · Write" }),
		).toBeInTheDocument();
	});

	it("offers no way to open a file the turn deleted", async () => {
		const user = userEvent.setup();
		render(
			<TurnChangesCard
				onOpenFile={vi.fn()}
				parts={[
					{
						type: "tool_call",
						tool: {
							id: "1",
							name: "Edit",
							input: {
								changes: [
									{ path: "/repo/a.ts", kind: { type: "update" }, diff: "" },
									{
										path: "/repo/gone.ts",
										kind: { type: "delete" },
										diff: "z\n",
									},
								],
							},
							status: "success",
						},
					},
				]}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^gone\.ts/ }));
		expect(
			screen.queryByRole("button", { name: "Open" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^a\.ts/ }));
		expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
	});

	it("lists five of many files and the rest on request", async () => {
		const user = userEvent.setup();
		const parts = (count: number) =>
			Array.from({ length: count }, (_, i) =>
				edit(`${i}`, `/repo/f${i}.ts`, "a", "b"),
			);
		const { rerender } = render(<TurnChangesCard parts={parts(7)} />);
		expect(screen.getAllByRole("button")).toHaveLength(7);

		rerender(<TurnChangesCard parts={parts(9)} />);
		const more = screen.getByRole("button", { name: "Show 4 more files" });
		expect(more).not.toHaveAttribute("aria-expanded");
		expect(screen.getAllByRole("button")).toHaveLength(6);
		await user.click(more);
		expect(screen.getAllByRole("button")).toHaveLength(9);
		expect(screen.getByRole("button", { name: /^f5\.ts/ })).toHaveFocus();
		expect(card()).toHaveAccessibleName("9 files changed");
	});

	it("draws nothing when no file was changed", () => {
		const { container } = render(
			<TurnChangesCard
				parts={[
					{
						type: "tool_call",
						tool: {
							id: "1",
							name: "Edit",
							input: {
								file_path: "/repo/a.ts",
								old_string: "a",
								new_string: "b",
							},
							status: "error",
						},
					},
				]}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	describe("in a message", () => {
		const message = (status: AssistantMessage["status"]): AssistantMessage => ({
			id: "m",
			role: "assistant",
			parts: [
				{ type: "text", content: "Done." },
				edit("1", "/repo/a.ts", "a", "b"),
			],
			status,
			createdAt: new Date(),
		});

		it("waits for the turn to settle", () => {
			const { rerender } = render(
				<MessageItem sessionId="s" message={message("streaming")} />,
			);
			expect(card()).not.toBeInTheDocument();

			rerender(<MessageItem sessionId="s" message={message("complete")} />);
			expect(card()).toBeInTheDocument();
		});

		it("sits under how the turn ended, just above its actions", () => {
			render(<MessageItem sessionId="s" message={message("interrupted")} />);
			const status = screen.getByText("Interrupted");
			const group = card() as HTMLElement;
			const actions = screen.getByRole("group", { name: "Message actions" });
			expect(
				status.compareDocumentPosition(group) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				group.compareDocumentPosition(actions) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		});
	});
});
