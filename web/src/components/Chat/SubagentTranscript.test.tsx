import { LayerHistoryContext } from "@pockode/shared";
import { createMemoryHistory } from "@tanstack/react-router";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type Ref, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { layerHistoryFor } from "../../lib/layerHistory";
import type {
	AssistantMessage,
	ContentPart,
	Message,
	ToolRun,
} from "../../types/message";
import {
	SubagentTranscript,
	type SubagentTranscriptHandle,
} from "./SubagentTranscript";

type History = ReturnType<typeof createMemoryHistory>;

let partId = 0;
const text = (content: string, parentToolUseId?: string): ContentPart => ({
	type: "text",
	id: `text-${++partId}`,
	content,
	...(parentToolUseId ? { parentToolUseId } : {}),
});
const read = (id: string, filePath = "/repo/sender.go"): ContentPart => ({
	type: "tool_call",
	id: `call-${id}`,
	tool: {
		id,
		name: "Read",
		input: { file_path: filePath },
		status: "success",
	},
});
const pendingCard = (toolUseId: string): ContentPart => ({
	type: "permission_request",
	id: `card-${toolUseId}`,
	request: {
		requestId: `r-${toolUseId}`,
		toolName: "Bash",
		toolInput: { command: `rm -rf ${toolUseId}` },
		toolUseId,
	},
	status: "pending",
});
const agent = (run: Partial<ToolRun> & { id: string }): ContentPart => ({
	type: "tool_call",
	id: `call-${run.id}`,
	tool: {
		name: "Agent",
		input: {
			description: "review the sender",
			subagent_type: "Explore",
			prompt: "Look at server/relay for retries.",
		},
		status: "running",
		...run,
	},
});
const reply = (...parts: ContentPart[]): AssistantMessage => ({
	id: `m-${++partId}`,
	role: "assistant",
	parts,
	status: "complete",
	createdAt: new Date(0),
});

/**
 * The layer as the chat holds it: the stack is state, and the layer is drawn
 * while it holds a level.
 */
function renderLayer(
	messages: Message[],
	props: {
		escapeHeld?: boolean;
		path?: string[];
		history?: History;
		handle?: Ref<SubagentTranscriptHandle>;
	} = {},
) {
	let path: string[] = [];
	function Harness({ msgs }: { msgs: Message[] }) {
		const [levels, setLevels] = useState(props.path ?? ["t1"]);
		path = levels;
		return levels.length > 0 ? (
			<SubagentTranscript
				ref={props.handle}
				messages={msgs}
				path={levels}
				onPathChange={setLevels}
				escapeHeld={props.escapeHeld ?? false}
				partProps={{ sessionId: "s1", onPermissionRespond: vi.fn() }}
			/>
		) : null;
	}
	const ui = (msgs: Message[]) =>
		props.history ? (
			<LayerHistoryContext value={layerHistoryFor(props.history)}>
				<Harness msgs={msgs} />
			</LayerHistoryContext>
		) : (
			<Harness msgs={msgs} />
		);
	const result = render(ui(messages));
	return {
		path: () => path,
		rerender: (msgs: Message[]) => result.rerender(ui(msgs)),
	};
}

// The header is a `<header>` inside the layer's section, which makes it no
// landmark of its own; it is reached from the breadcrumb it holds.
const header = (): HTMLElement => {
	const el = screen
		.getByRole("navigation", { name: "Subagent path" })
		.closest("header");
	if (!el) throw new Error("no header around the breadcrumb");
	return el;
};
const level = () =>
	screen.getByRole("region", { name: "Explore subagent's work" });

describe("SubagentTranscript", () => {
	it("is named for the subagent and says where it is", () => {
		renderLayer([reply(agent({ id: "t1" }))]);
		expect(
			screen.getByRole("region", { name: "Explore subagent's transcript" }),
		).toBeVisible();
		const path = screen.getByRole("navigation", { name: "Subagent path" });
		expect(within(path).getByRole("button", { name: "Chat" })).toBeVisible();
		expect(
			within(path).getByText("Explore").closest("[aria-current]"),
		).toHaveAttribute("aria-current", "page");
		// The row, without its title: the title is the last crumb.
		expect(screen.getByText("review the sender")).toBeVisible();
		expect(
			screen.getByRole("status", { name: "Subagent running" }),
		).toBeVisible();
	});

	it("focuses the level so the keyboard scrolls it at once", () => {
		renderLayer([reply(agent({ id: "t1" }))]);
		expect(level()).toHaveFocus();
	});

	it("reads the prompt, then the work as a conversation of its own", () => {
		renderLayer([
			reply(
				agent({
					id: "t1",
					children: [text("I'll start with the sender."), read("c1")],
				}),
			),
		]);
		expect(within(level()).getByText("Prompt")).toBeVisible();
		expect(
			within(level()).getByText("Look at server/relay for retries."),
		).toBeVisible();
		// Text at full weight, not the Process's note.
		const words = within(level()).getByText("I'll start with the sender.");
		expect(words.closest(".markdown-note")).toBeNull();
		expect(within(level()).getByText("Read")).toBeVisible();
	});

	it("draws children that sit flat after the filed ones, in arrival order", () => {
		renderLayer([
			reply(agent({ id: "t1", children: [text("first, filed")] })),
			reply(text("then, flat", "t1"), text("someone else's", "t9")),
		]);
		const all = within(level()).getAllByText(/^(first, filed|then, flat)$/);
		expect(all.map((el) => el.textContent)).toEqual([
			"first, filed",
			"then, flat",
		]);
		expect(within(level()).queryByText("someone else's")).toBeNull();
	});

	it("ends on the report once, under its label", () => {
		renderLayer([
			reply(
				agent({
					id: "t1",
					status: "success",
					result: "The sender retries on 429.",
					children: [read("c1"), text("The sender retries on 429.")],
					subagent: { agentId: "a555" },
				}),
			),
		]);
		expect(within(level()).getByText("Report")).toBeVisible();
		expect(
			within(level()).getAllByText("The sender retries on 429."),
		).toHaveLength(1);
		expect(within(level()).getByText("a555")).toBeVisible();
	});

	it("says nothing about a report while the subagent is still working", () => {
		renderLayer([reply(agent({ id: "t1", children: [read("c1")] }))]);
		expect(screen.queryByText(/still working/)).toBeNull();
		expect(within(level()).queryByText("Report")).toBeNull();
	});

	it("follows the run as it streams", () => {
		const { rerender } = renderLayer([
			reply(agent({ id: "t1", children: [text("looking")] })),
		]);
		rerender([
			reply(
				agent({
					id: "t1",
					status: "success",
					result: "done",
					children: [text("looking"), read("c1")],
				}),
			),
		]);
		expect(within(level()).getByText("Read")).toBeVisible();
		expect(within(header()).getByLabelText("succeeded")).toBeVisible();
	});

	it("says why on the header when the subagent failed", () => {
		renderLayer([
			reply(
				agent({
					id: "t1",
					status: "error",
					result: "Could not reach the relay.",
					children: [read("c1")],
				}),
			),
		]);
		const top = header();
		expect(within(top).getByText("review the sender")).toHaveClass(
			"text-th-error",
		);
		expect(within(top).getByText("Could not reach the relay.")).toBeVisible();
	});

	// The header is the row without its title: it keeps the row's chips.
	it("says on the header that the subagent finished after the Stop", () => {
		renderLayer([
			reply(
				agent({
					id: "t1",
					status: "interrupted",
					result: "sub-done",
					finishedAfterStop: true,
					children: [read("c1")],
				}),
			),
		]);
		const top = header();
		expect(within(top).getByLabelText("succeeded")).toBeVisible();
		expect(within(top).getByText("after Stop")).toBeVisible();
	});

	describe("a step that asks the user", () => {
		it("draws the shown subagent's own card in place, with no asker", () => {
			renderLayer([
				reply(agent({ id: "t1", children: [read("c1"), pendingCard("c2")] })),
			]);
			const card = level().querySelector('[data-permission-request-id="r-c2"]');
			expect(card).toBeVisible();
			expect(card).not.toHaveTextContent("Asked by");
		});

		it("draws a nested subagent's card in that subagent's row slot", () => {
			const nested = agent({
				id: "t2",
				input: { description: "inner", subagent_type: "Plan" },
				children: [pendingCard("c9")],
			});
			renderLayer([reply(agent({ id: "t1", children: [nested] }))]);
			// Visible with the nested row closed: the slot is outside its body.
			const card = level().querySelector('[data-permission-request-id="r-c9"]');
			expect(card).toBeVisible();
			// Its own row's card, as in the chat: the asker line is for one from
			// deeper down than the row it is drawn under.
			expect(card).not.toHaveTextContent("Asked by");
		});
	});

	describe("closing", () => {
		it("closes from ← and from the Chat crumb", async () => {
			const user = userEvent.setup();
			renderLayer([reply(agent({ id: "t1" }))]);
			await user.click(screen.getByRole("button", { name: "Back to chat" }));
			expect(screen.queryByRole("region")).toBeNull();

			renderLayer([reply(agent({ id: "t1" }))]);
			await user.click(screen.getByRole("button", { name: "Chat" }));
			expect(screen.queryByRole("region")).toBeNull();
		});

		it("closes on Escape, and claims the key", () => {
			const { path } = renderLayer([reply(agent({ id: "t1" }))]);
			const event = new KeyboardEvent("keydown", {
				key: "Escape",
				cancelable: true,
				bubbles: true,
			});
			act(() => {
				document.dispatchEvent(event);
			});
			expect(path()).toEqual([]);
			expect(event.defaultPrevented).toBe(true);
		});

		// The answer panel is drawn over the layer and claims Escape after it.
		it("leaves Escape to the answer panel while it is up", () => {
			const { path } = renderLayer([reply(agent({ id: "t1" }))], {
				escapeHeld: true,
			});
			fireEvent.keyDown(document, { key: "Escape" });
			expect(path()).toEqual(["t1"]);
		});

		it("leaves a key something else already claimed", () => {
			const { path } = renderLayer([reply(agent({ id: "t1" }))]);
			const event = new KeyboardEvent("keydown", {
				key: "Escape",
				cancelable: true,
				bubbles: true,
			});
			event.preventDefault();
			act(() => {
				document.dispatchEvent(event);
			});
			expect(path()).toEqual(["t1"]);
		});

		it("closes once the run is no longer in the transcript", () => {
			const { path, rerender } = renderLayer([reply(agent({ id: "t1" }))]);
			rerender([reply(text("rewound"))]);
			expect(path()).toEqual([]);
			expect(screen.queryByRole("region")).toBeNull();
		});
	});

	// docs/subagent-transcript-ui.md#back-at-each-depth
	describe("nested levels", () => {
		const plan = (children: ContentPart[] = [read("c5")]) =>
			agent({
				id: "t2",
				input: {
					description: "plan the fix",
					subagent_type: "Plan",
					prompt: "Plan it.",
				},
				children,
			});
		const reviewer = agent({
			id: "t3",
			input: {
				description: "review the plan",
				subagent_type: "code-reviewer",
				prompt: "Review it.",
			},
			children: [read("c7")],
		});
		const deep = () => [
			reply(agent({ id: "t1", children: [text("outer"), plan([reviewer])] })),
		];
		const work = (title: string) =>
			screen.getByRole("region", { name: `${title} subagent's work` });
		const history = () =>
			createMemoryHistory({ initialEntries: ["/before", "/page"] });
		const depth = (h: History) =>
			(h.location.state as { pockodeLayers?: string[] }).pockodeLayers
				?.length ?? 0;

		it("draws the whole path, the levels under the top kept but put away", () => {
			renderLayer(deep(), { path: ["t1", "t2", "t3"] });
			expect(
				screen.getByRole("region", {
					name: "code-reviewer subagent's transcript",
				}),
			).toBeVisible();
			expect(work("code-reviewer").closest("[inert]")).toBeNull();
			for (const title of ["Explore", "Plan"]) {
				expect(work(title).closest("[inert]")).toHaveClass("invisible");
			}
			const path = within(
				work("code-reviewer").parentElement as HTMLElement,
			).getByRole("navigation", { name: "Subagent path" });
			expect(
				within(path)
					.getAllByRole("listitem")
					.map((crumb) => crumb.textContent),
			).toEqual(["Chat", "Explore", "Plan", "code-reviewer"]);
			expect(
				within(path).getByText("code-reviewer").closest("[aria-current]"),
			).toHaveAttribute("aria-current", "page");
			// Every crumb but the shown subagent goes up.
			expect(
				within(path)
					.getAllByRole("button")
					.map((b) => b.textContent),
			).toEqual(["Chat", "Explore", "Plan"]);
		});

		it("goes up one level on Back, ← and Escape", async () => {
			const user = userEvent.setup();
			const h = history();
			const { path } = renderLayer(deep(), {
				path: ["t1", "t2", "t3"],
				history: h,
			});
			// One history entry per level.
			await waitFor(() => expect(depth(h)).toBe(3));

			act(() => h.back());
			await waitFor(() => expect(path()).toEqual(["t1", "t2"]));
			expect(depth(h)).toBe(2);

			await user.click(screen.getByRole("button", { name: "Back to Explore" }));
			expect(path()).toEqual(["t1"]);
			await waitFor(() => expect(depth(h)).toBe(1));

			fireEvent.keyDown(document, { key: "Escape" });
			expect(path()).toEqual([]);
			await waitFor(() => expect(depth(h)).toBe(0));
		});

		it("goes up several levels from a crumb, in one traversal", async () => {
			const user = userEvent.setup();
			const h = history();
			// Before the layer history binds it.
			const go = vi.spyOn(h, "go");
			const { path } = renderLayer(deep(), {
				path: ["t1", "t2", "t3"],
				history: h,
			});
			await waitFor(() => expect(depth(h)).toBe(3));
			await user.click(
				within(work("code-reviewer").parentElement as HTMLElement).getByRole(
					"button",
					{ name: "Explore" },
				),
			);
			expect(path()).toEqual(["t1"]);
			await waitFor(() => expect(depth(h)).toBe(1));
			expect(go.mock.calls).toEqual([[-2]]);
		});

		it("goes down from a ⤢ in the level, and focus comes back to it", async () => {
			const user = userEvent.setup();
			const { path } = renderLayer([
				reply(agent({ id: "t1", children: [plan()] })),
			]);
			await user.click(
				within(work("Explore")).getByRole("button", { name: /plan the fix/ }),
			);
			const opener = within(work("Explore")).getByRole("button", {
				name: "Open Plan subagent's transcript",
			});
			await user.click(opener);
			expect(path()).toEqual(["t1", "t2"]);
			expect(work("Plan")).toHaveFocus();

			await user.click(screen.getByRole("button", { name: "Back to Explore" }));
			expect(path()).toEqual(["t1"]);
			expect(opener).toHaveFocus();
		});

		it("closes the levels from one whose run is gone", () => {
			const { path, rerender } = renderLayer(deep(), {
				path: ["t1", "t2", "t3"],
			});
			rerender([reply(agent({ id: "t1", children: [text("outer")] }))]);
			expect(path()).toEqual(["t1"]);
			expect(work("Explore").closest("[inert]")).toBeNull();
		});

		it("offers the strip's jump only for a card on the level on screen", () => {
			const handle = createRef<SubagentTranscriptHandle>();
			renderLayer(
				[
					reply(
						agent({
							id: "t1",
							children: [plan([pendingCard("c5")]), pendingCard("c1")],
						}),
					),
				],
				{ path: ["t1", "t2"], handle },
			);
			expect(handle.current?.hasRequest("r-c5")).toBe(true);
			// Drawn in the level under the top, which is not on screen.
			expect(handle.current?.hasRequest("r-c1")).toBe(false);

			fireEvent.keyDown(document, { key: "Escape" });
			expect(handle.current?.hasRequest("r-c1")).toBe(true);
		});
	});
});
