import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProposedChangeData } from "../../lib/proposedChange";
import { turnChanges } from "../../lib/turnChanges";
import { type TurnWork, turnWork } from "../../lib/turnWork";
import type { AssistantMessage, ContentPart } from "../../types/message";
import MessageItem from "./MessageItem";
import MessageList from "./MessageList";
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
				: change.kind === "notebook"
					? change.input.notebook_path
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

/**
 * The card as a settled message with these parts draws it, its span
 * unmeasured unless `work` says otherwise.
 */
function Card({
	parts,
	work,
	...props
}: Omit<ComponentProps<typeof TurnChangesCard>, "work" | "changes"> & {
	parts: ContentPart[];
	work?: TurnWork;
}) {
	const counted =
		work ??
		turnWork({
			id: "m",
			role: "assistant",
			parts,
			status: "complete",
			createdAt: new Date(),
		});
	return counted ? (
		<TurnChangesCard
			changes={turnChanges(parts, "/repo")}
			work={counted}
			{...props}
		/>
	) : null;
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

	it("draws nothing when the calls changed no file", () => {
		const { container } = render(
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
		expect(container).toBeEmptyDOMElement();
	});

	it("says how long the reply worked, when both ends were stamped", () => {
		render(
			<Card
				parts={[edit("1", "/repo/a.ts", "a", "b")]}
				work={{ calls: 6, durationMs: 133_400 }}
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

	it("leaves a reply whose start is not loaded at its files", () => {
		render(<Card parts={[edit("1", "/repo/a.ts", "a", "b")]} work={{}} />);
		expect(card()).toHaveAccessibleName("1 file changed");
		// Alone, the entry is never shortened to a fragment: no part of it is
		// left for the container query to hide.
		expect(
			within(card() as HTMLElement).queryByText(/^changed$/),
		).not.toBeInTheDocument();
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

		it("closes the turn: after the answer and how it ended, above the actions", () => {
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
			const actions = screen.getByRole("group", { name: "Message actions" });
			expect(follows(screen.getByText("Both done."), group)).toBe(true);
			expect(follows(screen.getByText("Interrupted"), group)).toBe(true);
			expect(follows(group, actions)).toBe(true);
			// The figures are the card's, not said a second time on the row.
			expect(actions.parentElement).not.toHaveTextContent(/tool call/);
		});

		const reads = (status: AssistantMessage["status"] = "complete") =>
			message(status, [
				{
					type: "tool_call",
					id: "call-1",
					tool: { id: "1", name: "Read", input: {}, status: "success" },
				},
				text("1", "It is in sender.go."),
			]);
		const actionsRow = () =>
			screen.getByRole("group", { name: "Message actions" })
				.parentElement as HTMLElement;

		it("puts the figures of a turn that changed no file on the turn-end row", () => {
			const { rerender } = render(
				<MessageItem
					sessionId="s"
					message={{ ...reads("streaming"), openedAt: 0, endedAt: 48_000 }}
				/>,
			);
			expect(screen.queryByText(/tool call/)).not.toBeInTheDocument();

			rerender(
				<MessageItem
					sessionId="s"
					message={{ ...reads(), openedAt: 0, endedAt: 48_000 }}
				/>,
			);
			expect(card()).not.toBeInTheDocument();
			expect(
				within(actionsRow()).getByText("Worked 48 seconds, 1 tool call"),
			).toBeInTheDocument();
			// Not an action: outside the group the buttons are in.
			expect(
				within(
					screen.getByRole("group", { name: "Message actions" }),
				).queryByText(/tool call/),
			).not.toBeInTheDocument();
		});

		it("shows no figures on the row for a reply whose start is not loaded", () => {
			render(
				<MessageItem
					sessionId="s"
					message={{ ...reads(), startNotLoaded: true, endedAt: 5_000 }}
				/>,
			);
			expect(actionsRow()).toBeInTheDocument();
			expect(screen.queryByText(/tool call|Worked/)).not.toBeInTheDocument();
		});

		// A subagent the turn left running edits a file after it settled.
		it("moves the figures onto the card when a late edit brings one", () => {
			const settled = reads();
			const { rerender } = render(
				<MessageItem sessionId="s" message={settled} />,
			);
			expect(within(actionsRow()).getByText("1 tool call")).toBeInTheDocument();

			rerender(
				<MessageItem
					sessionId="s"
					message={{
						...settled,
						parts: [...settled.parts, edit("2", "/repo/a.ts", "a", "b")],
					}}
				/>,
			);
			expect(card()).toHaveAccessibleName("2 tool calls, 1 file changed");
			expect(actionsRow()).not.toHaveTextContent(/tool call/);
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

		it("counts nothing on a reply whose start is not loaded", () => {
			render(
				<MessageItem
					sessionId="s"
					message={{
						...message("complete"),
						startNotLoaded: true,
						endedAt: 5_000,
					}}
				/>,
			);
			expect(card()).toHaveAccessibleName("1 file changed");
		});

		// A subagent's steps left flat by a fork that cut off their call are the
		// reply's work: its files are listed, with nothing counted.
		it("lists the files of a reply whose only calls are flat steps", () => {
			const step = (part: ContentPart) => ({
				...part,
				parentToolUseId: "task-9",
			});
			render(
				<MessageItem
					sessionId="s"
					message={message("complete", [
						step(edit("1", "/repo/a.ts", "a", "b")),
						text("1", "Done."),
					])}
				/>,
			);
			expect(card()).toHaveAccessibleName("1 file changed");
		});

		it("gives each reply a read point split off its own span", () => {
			render(
				<MessageItem
					sessionId="s"
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

	// docs/tool-call-ui.md#from-a-file-to-the-calls-that-changed-it
	describe("going to the call", () => {
		const read = (id: string, path: string): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: {
				id,
				name: "Read",
				input: { file_path: path },
				status: "success",
				result: "contents",
			},
		});
		const subagent = (id: string, children: ContentPart[]): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: {
				id,
				name: "Agent",
				input: { description: "Fix the retry", prompt: "Fix it." },
				status: "success",
				result: "Fixed.",
				children,
			},
		});
		const transcript = (parts: ContentPart[]) =>
			render(
				<MessageList
					sessionId="s"
					messages={[
						{
							id: "m",
							role: "assistant",
							parts,
							status: "complete",
							createdAt: new Date(),
						},
					]}
				/>,
			);
		const toolRow = (id: string) =>
			document.querySelector<HTMLElement>(`[data-tool-use-id="${id}"]`);
		// Inside the card: the tool rows, once revealed, name the file too.
		const fileRow = (name: RegExp) =>
			within(card() as HTMLElement).getByRole("button", { name });
		const openFile = async (name: RegExp) =>
			userEvent.setup().click(fileRow(name));

		it("opens the group the call is folded into and lands on its row, closed", async () => {
			const user = userEvent.setup();
			transcript([
				read("r1", "/repo/a.ts"),
				edit("e1", "/repo/a.ts", "a", "b"),
				read("r2", "/repo/b.ts"),
				{ id: "text-done", type: "text", content: "Done." },
			]);
			const row = toolRow("e1");
			expect(row?.closest("[hidden]")).not.toBeNull();

			await openFile(/^a\.ts,/);
			await user.click(
				screen.getByRole("button", {
					name: "Go to call that made this change",
				}),
			);

			expect(row?.closest("[hidden]")).toBeNull();
			expect(row).toHaveClass("jump-highlight");
			const rowButton = row?.querySelector("button");
			expect(rowButton).toHaveFocus();
			// What the reader went for is around the row, not its body: the diff
			// they came from.
			expect(rowButton).toHaveAttribute("aria-expanded", "false");
		});

		it("reaches a subagent's step through its row, Process and group, and leaves them open", async () => {
			const user = userEvent.setup();
			transcript([
				edit("e1", "/repo/a.ts", "a", "b"),
				subagent("t1", [
					read("c1", "/repo/a.ts"),
					edit("c2", "/repo/a.ts", "b", "c"),
					read("c3", "/repo/a.ts"),
				]),
				{ id: "text-done", type: "text", content: "Done." },
			]);
			// Never opened, so not even mounted.
			expect(toolRow("c2")).toBeNull();

			await openFile(/^a\.ts,/);
			await user.click(
				screen.getByRole("button", { name: "Go to call 2 · Edit" }),
			);

			const row = toolRow("c2");
			expect(row?.closest("[hidden]")).toBeNull();
			expect(row).toHaveClass("jump-highlight");
			expect(row?.querySelector("button")).toHaveFocus();
			expect(screen.getByRole("button", { name: /^Process/ })).toHaveAttribute(
				"aria-expanded",
				"true",
			);

			// The other change goes to the main agent's row; the subagent's stays
			// open behind it, and so does the file row the reader came from.
			await user.click(
				screen.getByRole("button", { name: "Go to call 1 · Edit" }),
			);
			expect(toolRow("e1")).toHaveClass("jump-highlight");
			expect(toolRow("c2")).not.toHaveClass("jump-highlight");
			expect(toolRow("c2")?.closest("[hidden]")).toBeNull();
			expect(fileRow(/^a\.ts,/)).toHaveAttribute("aria-expanded", "true");
		});
	});
});
