import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProposedChangeData } from "../../lib/proposedChange";
import { turnWork } from "../../lib/turnWork";
import type { AssistantMessage, ContentPart } from "../../types/message";
import MessageItem from "./MessageItem";
import { TurnChangesCard } from "./TurnChangesCard";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: "/repo" }),
}));

// The diff itself is `ProposedChange`'s to draw, and its viewer measures text
// on a canvas jsdom does not have; what the card owes is handing it each edit.
vi.mock("./ProposedChange", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ProposedChange")>()),
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
	id: `call-${id}`,
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
		id: `call-${id}`,
		tool: {
			id,
			name: "Write",
			input: { file_path: path, content },
			status: "success",
			result,
		},
	}) satisfies ContentPart;

const card = () => screen.queryByRole("group", { name: /changed$/ });

/** The card as a settled message with these parts draws it, its span unmeasured. */
function Card({
	parts,
	...props
}: Omit<ComponentProps<typeof TurnChangesCard>, "work">) {
	const work = turnWork(
		{
			id: "m",
			role: "assistant",
			parts,
			status: "complete",
			createdAt: new Date(),
		},
		false,
	);
	return work ? <TurnChangesCard parts={parts} work={work} {...props} /> : null;
}

describe("TurnChangesCard", () => {
	it("names each file by where it is and what the turn did to it", () => {
		render(
			<Card
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
		expect(group).toHaveAccessibleName("3 tool calls, 3 files changed");
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
			<Card
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
			<Card
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
			<Card
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
		expect(diff.closest(".overflow-y-hidden")).toBeInTheDocument();
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
			<Card
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
			<Card
				onOpenFile={vi.fn()}
				parts={[
					{
						type: "tool_call",
						id: "call-1",
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
		const { rerender } = render(<Card parts={parts(7)} />);
		expect(screen.getAllByRole("button")).toHaveLength(7);

		rerender(<Card parts={parts(9)} />);
		const more = screen.getByRole("button", { name: "Show 4 more files" });
		expect(more).not.toHaveAttribute("aria-expanded");
		expect(screen.getAllByRole("button")).toHaveLength(6);
		await user.click(more);
		expect(screen.getAllByRole("button")).toHaveLength(9);
		expect(screen.getByRole("button", { name: /^f5\.ts/ })).toHaveFocus();
		expect(card()).toHaveAccessibleName("9 tool calls, 9 files changed");
	});

	it("draws the line alone when the calls changed no file", () => {
		render(
			<Card
				parts={[
					{
						type: "tool_call",
						id: "call-1",
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
		expect(card()).not.toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.getByText("1 tool call")).toBeInTheDocument();
	});

	it("says how long the reply worked, when both ends were stamped", () => {
		render(
			<TurnChangesCard
				parts={[edit("1", "/repo/a.ts", "a", "b")]}
				work={{ lastCallPartId: "call-1", calls: 6, durationMs: 133_400 }}
			/>,
		);
		expect(card()).toHaveAccessibleName(
			"Worked 2 minutes 13 seconds, 6 tool calls, 1 file changed",
		);
		// The visible words, both noun forms present: which one shows is the
		// container query's, which jsdom does not lay out.
		expect(card()).toHaveTextContent(
			"Worked 2m 13s · 6 tool calls · 1 file changed",
		);
	});

	it("leaves a reply the oldest page may have cut at its files", () => {
		const cut = { lastCallPartId: "call-1" };
		const { container, rerender } = render(
			<TurnChangesCard
				parts={[edit("1", "/repo/a.ts", "a", "b")]}
				work={cut}
			/>,
		);
		expect(card()).toHaveAccessibleName("1 file changed");

		rerender(
			<TurnChangesCard
				parts={[
					{
						type: "tool_call",
						id: "call-1",
						tool: { id: "1", name: "Read", input: {}, status: "success" },
					},
				]}
				work={cut}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	describe("in a message", () => {
		const text = (id: string, content: string): ContentPart => ({
			id: `text-${id}`,
			type: "text",
			content,
		});
		const message = (
			status: AssistantMessage["status"],
			parts: ContentPart[] = [
				text("1", "Looking."),
				edit("1", "/repo/a.ts", "a", "b"),
				text("2", "Done."),
			],
		): AssistantMessage => ({
			id: "m",
			role: "assistant",
			parts,
			status,
			createdAt: new Date(),
		});
		const follows = (a: Node, b: Node) =>
			!!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

		it("waits for the turn to settle", () => {
			const { rerender } = render(
				<MessageItem sessionId="s" message={message("streaming")} />,
			);
			expect(card()).not.toBeInTheDocument();

			rerender(<MessageItem sessionId="s" message={message("complete")} />);
			expect(card()).toBeInTheDocument();
		});

		it("stands between the work and the answer, above how the turn ended", () => {
			render(
				<MessageItem
					sessionId="s"
					message={message("interrupted", [
						edit("1", "/repo/a.ts", "a", "b"),
						text("1", "Now the other one."),
						edit("2", "/repo/b.ts", "a", "b"),
						text("2", "Both done."),
					])}
				/>,
			);
			const group = card() as HTMLElement;
			// Text between two lists is narration, among the work.
			expect(follows(screen.getByText("Now the other one."), group)).toBe(true);
			expect(follows(group, screen.getByText("Both done."))).toBe(true);
			expect(follows(group, screen.getByText("Interrupted"))).toBe(true);
			expect(
				follows(
					screen.getByText("Both done."),
					screen.getByRole("group", { name: "Message actions" }),
				),
			).toBe(true);
		});

		it("draws nothing for a reply that made no call", () => {
			render(
				<MessageItem
					sessionId="s"
					message={message("complete", [text("1", "Just words.")])}
				/>,
			);
			expect(screen.queryByText(/tool call/)).not.toBeInTheDocument();
		});

		it("closes nothing the reader opened when it goes in", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<MessageItem
					sessionId="s"
					message={message("streaming", [edit("1", "/repo/a.ts", "a", "b")])}
				/>,
			);
			const row = screen.getByRole("button", { expanded: false });
			await user.click(row);
			expect(row).toHaveAttribute("aria-expanded", "true");

			rerender(
				<MessageItem
					sessionId="s"
					message={message("complete", [
						edit("1", "/repo/a.ts", "a", "b"),
						text("1", "Done."),
					])}
				/>,
			);
			expect(card()).toBeInTheDocument();
			expect(row).toBeInTheDocument();
			expect(row).toHaveAttribute("aria-expanded", "true");
		});

		it("counts only what it can see the start of at the top of loaded history", () => {
			render(
				<MessageItem
					sessionId="s"
					olderPagesAbove
					message={{ ...message("complete"), endedAt: 5_000 }}
				/>,
			);
			expect(card()).toHaveAccessibleName("1 file changed");
		});

		it("gives each reply a read point split off its own span", () => {
			render(
				<MessageItem
					sessionId="s"
					olderPagesAbove
					message={{
						...message("complete"),
						openedAtReadPoint: true,
						openedAt: 1_000,
						endedAt: 121_000,
					}}
				/>,
			);
			expect(card()).toHaveAccessibleName(
				"Worked 2 minutes 0 seconds, 1 tool call, 1 file changed",
			);
		});
	});
});
