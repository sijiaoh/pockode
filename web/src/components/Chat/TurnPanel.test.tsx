import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useTurnOverview } from "../../hooks/useTurnOverview";
import { hasText, type LiveThinking } from "../../lib/thinking";
import type {
	ContentPart,
	Message,
	PlanStep,
	ToolRunStatus,
	TurnPhase,
} from "../../types/message";
import MessageList from "./MessageList";
import {
	type OpenSubagentTranscript,
	SubagentTranscriptContext,
} from "./subagentTranscriptContext";
import { IDLE_TAIL } from "./turnTailContext";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: "/repo" }),
}));

const agent = (
	id: string,
	type: string,
	description: string,
	status: ToolRunStatus,
	children: ContentPart[] = [],
): ContentPart => ({
	type: "tool_call",
	id: `part-${id}`,
	tool: {
		id,
		name: "Agent",
		input: { description, subagent_type: type, prompt: "Go." },
		status,
		children,
		result: status === "success" ? "Done." : undefined,
	},
});

const said = (id: string, content: string): ContentPart => ({
	type: "text",
	id,
	content,
});

const read = (id: string, path: string): ContentPart => ({
	type: "tool_call",
	id: `part-${id}`,
	tool: { id, name: "Read", input: { file_path: path }, status: "success" },
});

const reply = (
	id: string,
	parts: ContentPart[],
	status: "streaming" | "complete" = "streaming",
): Message => ({
	id,
	role: "assistant",
	parts,
	status,
	createdAt: new Date(),
});

/**
 * The transcript as `useChatMessages` feeds it: the plan, the agents and the
 * panel held beside the messages, and the slot that draws them worked out from
 * them.
 */
function Transcript({
	messages,
	phase,
	sessionId = "s",
	openTranscript = null,
	thinking = null,
}: {
	messages: Message[];
	phase: TurnPhase;
	sessionId?: string;
	/** What the main agent is thinking now, as `useChatMessages` holds it. */
	thinking?: LiveThinking | null;
	/** What the chat provides; none, as outside a chat, by default. */
	openTranscript?: OpenSubagentTranscript | null;
}) {
	const open = phase !== "idle" || messages.some((m) => m.status === "sending");
	const tail = {
		...IDLE_TAIL,
		phase,
		thinking,
		...useTurnOverview(
			messages,
			open,
			sessionId,
			phase === "running" && thinking !== null && hasText(thinking),
		),
	};
	return (
		<SubagentTranscriptContext value={openTranscript}>
			<MessageList sessionId="s" messages={messages} tail={tail} />
		</SubagentTranscriptContext>
	);
}

const three = (third: ToolRunStatus = "running") => [
	reply("m", [
		agent("a", "Explore", "Find retry handling", "running", [
			read("a1", "/repo/sender.go"),
			said("a2", "Looking at sender.go"),
		]),
		agent("b", "code-reviewer", "Review the diff", "background", [
			said("b1", "Checking the 503 path next."),
		]),
		agent("c", "Plan", "Draft the migration", third),
	]),
];

// The rows' own buttons are named "Subagent running" by their glyph; the
// status line's name always ends on what a press does.
const STATUS = /details$/;
const statusLine = (name: RegExp | string = STATUS) =>
	screen.getByRole("button", { name });
// The panel's entries are the only buttons named after their row.
const entry = (name: RegExp) =>
	within(screen.getByRole("list", { name: "Agents" })).getByRole("button", {
		name,
	});
const toolRow = (id: string) =>
	document.querySelector<HTMLElement>(`[data-tool-use-id="${id}"]`);
const inMessage = (id: string, element: Element) =>
	document.querySelector(`[data-message-id="${id}"]`)?.contains(element);

describe("the status line's agents", () => {
	it("counts the live subagents and names the last one, with what it is doing", () => {
		render(<Transcript messages={three("success")} phase="running" />);
		const line = statusLine("Working, 2 agents running, details");
		expect(line).toHaveAttribute("aria-expanded", "false");
		// The latest live one in transcript order, not whichever moved last.
		expect(line).toHaveTextContent(
			/^Working·2·code-reviewerChecking the 503 path next\.$/,
		);
	});

	// A background wait is when the count is needed most.
	it("stays while the turn is blocked, leading the line", () => {
		render(<Transcript messages={three()} phase="blocked" />);
		expect(statusLine("3 agents running, details")).toHaveTextContent(
			/^3·Plan$/,
		);
	});

	it("is not counted while no subagent is live", () => {
		render(
			<Transcript
				messages={[reply("m", [agent("a", "Explore", "x", "success")])]}
				phase="running"
			/>,
		);
		expect(
			screen.queryByRole("button", { name: STATUS }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Working")).toBeInTheDocument();
	});

	it("opens a list of the live agents, in transcript order", async () => {
		const user = userEvent.setup();
		render(<Transcript messages={three("success")} phase="running" />);
		await user.click(statusLine());

		expect(screen.getByText("Agents · 2 running")).toBeInTheDocument();
		const items = within(
			screen.getByRole("list", { name: "Agents" }),
		).getAllByRole("button");
		expect(items.map((item) => item.getAttribute("aria-label"))).toEqual([
			"Explore, Find retry handling, running, go to its row",
			"code-reviewer, Review the diff, running in the background, go to its row",
		]);
		// Drawn from the run as its row is: the second line is the row's.
		expect(items[0]).toHaveTextContent("1 tool use·Looking at sender.go");
	});

	// Where its row's ⤢ would take the reader (docs/subagent-transcript-ui.md).
	it("opens the transcript of an agent with work to show", async () => {
		const user = userEvent.setup();
		const openTranscript = vi.fn();
		render(
			<Transcript
				messages={three()}
				phase="running"
				openTranscript={openTranscript}
			/>,
		);
		await user.click(statusLine());
		const explore = entry(/^Explore,/);
		expect(explore).toHaveAccessibleName(
			"Explore, Find retry handling, running, open its transcript",
		);
		await user.click(explore);

		expect(openTranscript).toHaveBeenCalledWith("a", explore);
	});

	// No ⤢ on its row either: it has nothing to show as a transcript yet.
	it("goes to the row of an agent with no work to show", async () => {
		const user = userEvent.setup();
		const openTranscript = vi.fn();
		render(
			<Transcript
				messages={three()}
				phase="running"
				openTranscript={openTranscript}
			/>,
		);
		await user.click(statusLine());
		await user.click(
			entry(/^Plan, Draft the migration, running, go to its row$/),
		);

		expect(openTranscript).not.toHaveBeenCalled();
		const row = toolRow("c");
		expect(row).toHaveClass("jump-highlight");
		expect(row?.querySelector("button")).toHaveFocus();
	});

	// Nothing moves under a press.
	it("keeps an entry that settles while the panel is open, until it is closed", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<Transcript messages={three()} phase="running" />,
		);
		await user.click(statusLine());

		rerender(<Transcript messages={three("success")} phase="running" />);
		expect(
			statusLine("Working, 2 agents running, details"),
		).toBeInTheDocument();
		// It says it settled: drawn the same, it must not sound live either.
		expect(entry(/^Plan,/)).toHaveAccessibleName(
			"Plan, Draft the migration, succeeded, go to its row",
		);

		await user.click(statusLine());
		await user.click(statusLine());
		expect(
			within(screen.getByRole("list", { name: "Agents" })).queryByRole(
				"button",
				{ name: /^Plan,/ },
			),
		).not.toBeInTheDocument();
	});

	it("an agent started while the panel is open joins it and stays", async () => {
		const user = userEvent.setup();
		const one = [agent("a", "Explore", "Find retry handling", "running")];
		const { rerender } = render(
			<Transcript messages={[reply("m", one)]} phase="running" />,
		);
		await user.click(statusLine());

		const two = [...one, agent("d", "Docs", "Update the docs", "running")];
		rerender(<Transcript messages={[reply("m", two)]} phase="running" />);
		const settled = [one[0], agent("d", "Docs", "Update the docs", "success")];
		rerender(<Transcript messages={[reply("m", settled)]} phase="running" />);
		expect(entry(/^Docs,/)).toBeInTheDocument();
	});

	it("keeps the panel when the last one ends with it open, until it is closed", async () => {
		const user = userEvent.setup();
		const live = [agent("a", "Explore", "x", "running")];
		const { rerender } = render(
			<Transcript messages={[reply("m", live)]} phase="running" />,
		);
		await user.click(statusLine());

		const done = [agent("a", "Explore", "x", "success")];
		rerender(<Transcript messages={[reply("m", done)]} phase="running" />);
		// The section stays, saying why, and the chip at 0 with it.
		expect(statusLine("Working, no agents running, details")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(statusLine()).toHaveTextContent(/^Working·0$/);
		expect(screen.getByText("Agents · none running")).toBeInTheDocument();

		await user.click(statusLine());
		expect(
			screen.queryByRole("button", { name: STATUS }),
		).not.toBeInTheDocument();
	});

	// Nothing would be left to close it by: the line must still be there.
	it("keeps the line while the turn blocks with only settled entries open", async () => {
		const user = userEvent.setup();
		const live = [agent("a", "Explore", "x", "running")];
		const { rerender } = render(
			<Transcript messages={[reply("m", live)]} phase="running" />,
		);
		await user.click(statusLine());
		const done = [agent("a", "Explore", "x", "success")];
		rerender(<Transcript messages={[reply("m", done)]} phase="blocked" />);

		const line = statusLine("No agents running, details");
		expect(line).toHaveAttribute("aria-expanded", "true");
		await user.click(line);
		expect(screen.queryByText("Agents · none running")).not.toBeInTheDocument();
	});

	// A turn whose background budget ran out goes idle with its tasks going.
	it("moves to the right of the last reply's turn-end row while a subagent outlives the turn, closed", async () => {
		const user = userEvent.setup();
		const parts = [agent("b", "code-reviewer", "Review", "background")];
		const { rerender } = render(
			<Transcript messages={[reply("m", parts)]} phase="running" />,
		);
		await user.click(statusLine());

		const later: Message[] = [
			reply("m", parts, "complete"),
			reply("m2", [said("t", "Started the review.")], "complete"),
		];
		rerender(<Transcript messages={later} phase="idle" />);

		const chip = statusLine("1 agent running, details");
		expect(chip).toHaveAttribute("aria-expanded", "false");
		expect(chip).toHaveTextContent(/^1·code-reviewer/);
		expect(inMessage("m2", chip)).toBe(true);
		// Beside the actions, not one of them.
		expect(
			screen.getAllByRole("group", { name: "Message actions" }).at(-1),
		).not.toContainElement(chip);

		// Its panel holds the agents alone, and stays at none running while open.
		await user.click(chip);
		expect(entry(/^code-reviewer,/)).toBeInTheDocument();
		rerender(
			<Transcript
				messages={[
					reply(
						"m",
						[agent("b", "code-reviewer", "Review", "success")],
						"complete",
					),
					later[1],
				]}
				phase="idle"
			/>,
		);
		expect(statusLine("No agents running, details")).toHaveTextContent(
			/^0·No agents running$/,
		);
		await user.click(statusLine());
		expect(
			screen.queryByRole("button", { name: STATUS }),
		).not.toBeInTheDocument();
	});

	it("is drawn in one bubble only", () => {
		const messages: Message[] = [
			// A superseded reply left streaming, and the open one.
			reply("old", [agent("a", "Explore", "x", "running")]),
			reply("m", [agent("b", "Plan", "y", "running")]),
		];
		render(<Transcript messages={messages} phase="running" />);
		expect(screen.getAllByRole("button", { name: STATUS })).toHaveLength(1);
		expect(
			inMessage("m", statusLine("Working, 2 agents running, details")),
		).toBe(true);
	});

	// The chip moves into the new turn's line, and the panel closes with it.
	it("closes the panel when the next turn opens, from the send on", async () => {
		const user = userEvent.setup();
		const parts = [agent("b", "code-reviewer", "Review", "background")];
		const settled: Message[] = [reply("m", parts, "complete")];
		const { rerender } = render(<Transcript messages={settled} phase="idle" />);
		await user.click(statusLine());

		const sent: Message[] = [
			...settled,
			{
				id: "u",
				role: "user",
				content: "Next",
				status: "complete",
				createdAt: new Date(),
			},
			{
				id: "p",
				role: "assistant",
				parts: [],
				status: "sending",
				createdAt: new Date(),
			},
		];
		rerender(<Transcript messages={sent} phase="idle" />);
		const line = statusLine("Working, 1 agent running, details");
		expect(line).toHaveAttribute("aria-expanded", "false");
		expect(inMessage("p", line)).toBe(true);
	});

	it("closes the panel on another session", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<Transcript messages={three()} phase="running" />,
		);
		await user.click(statusLine());
		rerender(
			<Transcript messages={three()} phase="running" sessionId="other" />,
		);
		expect(statusLine()).toHaveAttribute("aria-expanded", "false");
	});
});

const todoWrite = (
	id: string,
	order: number,
	steps: PlanStep[],
	explanation?: string,
): ContentPart => ({
	type: "tool_call",
	id: `part-${id}`,
	tool: {
		id,
		name: "TodoWrite",
		input: {},
		status: "success",
		plan: { steps, order, ...(explanation ? { explanation } : {}) },
	},
});

const PLAN = [
	{
		text: "Write the retry tests",
		activeText: "Writing the retry tests",
		status: "in_progress",
	},
	{ text: "Update the docs", status: "pending" },
	{ text: "Read the code", status: "completed" },
] satisfies PlanStep[];

describe("the status line's plan", () => {
	it("says where the newest plan stands, and stays while the turn is blocked", () => {
		const { rerender } = render(
			<Transcript
				messages={[
					reply("m", [todoWrite("t1", 1, []), todoWrite("t2", 2, PLAN)]),
				]}
				phase="running"
			/>,
		);
		expect(statusLine()).toHaveAccessibleName("Working, plan 1 of 3, details");
		expect(statusLine()).toHaveTextContent(
			/^Working·1\/3·Now:Writing the retry tests$/,
		);

		rerender(
			<Transcript
				messages={[reply("m", [todoWrite("t2", 2, PLAN)])]}
				phase="blocked"
			/>,
		);
		expect(statusLine("Plan 1 of 3, details")).toBeInTheDocument();
	});

	// The plan's words outrank the agent's: they move less.
	it("puts both counts on one line, the plan's words after them", () => {
		render(
			<Transcript
				messages={[
					reply("m", [
						todoWrite("t", 1, PLAN),
						agent("a", "Explore", "Find retry handling", "running"),
					]),
				]}
				phase="running"
			/>,
		);
		expect(screen.getAllByRole("button", { name: STATUS })).toHaveLength(1);
		expect(statusLine()).toHaveAccessibleName(
			"Working, plan 1 of 3, 1 agent running, details",
		);
		expect(statusLine()).toHaveTextContent(
			/^Working·1\/3·1·Now:Writing the retry tests$/,
		);
	});

	it("opens the checklist in the panel, the explanation first, and follows new records", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<Transcript
				messages={[
					reply("m", [
						todoWrite("t", 1, PLAN, "Tests before the fix."),
						agent("a", "Explore", "Find retry handling", "running"),
					]),
				]}
				phase="running"
			/>,
		);
		await user.click(statusLine());
		expect(statusLine()).toHaveAttribute("aria-expanded", "true");
		const heading = screen.getByText("Plan · 1/3");
		const explanation = screen.getByText("Tests before the fix.");
		const checklist = explanation.parentElement?.querySelector("ul");
		expect(
			within(checklist as HTMLElement).getAllByRole("listitem"),
		).toHaveLength(3);
		// One panel, the plan's section above the agents'.
		const agents = screen.getByText("Agents · 1 running");
		for (const [first, second] of [
			[heading, explanation],
			[explanation, agents],
		]) {
			expect(
				first.compareDocumentPosition(second) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		}

		const done = PLAN.map((s) => ({ ...s, status: "completed" as const }));
		rerender(
			<Transcript
				messages={[
					reply("m", [
						todoWrite("t", 1, PLAN, "Tests before the fix."),
						agent("a", "Explore", "Find retry handling", "running"),
						todoWrite("t2", 2, done),
					]),
				]}
				phase="running"
			/>,
		);
		expect(statusLine()).toHaveTextContent(/·All done$/);
		expect(screen.getByText("Plan · 3/3")).toBeInTheDocument();
		expect(statusLine()).toHaveAttribute("aria-expanded", "true");
	});

	it("draws the other forms: more in progress, and what is next", () => {
		const both = [
			{ text: "Write tests", status: "in_progress" },
			{ text: "Fix sender", status: "in_progress" },
		] satisfies PlanStep[];
		const { rerender } = render(
			<Transcript
				messages={[reply("m", [todoWrite("t", 1, both)])]}
				phase="running"
			/>,
		);
		expect(statusLine()).toHaveTextContent(/·0\/2·Now:Write tests\+1$/);

		const next = [
			{ text: "Write tests", status: "completed" },
			{ text: "Fix sender", status: "pending" },
		] satisfies PlanStep[];
		rerender(
			<Transcript
				messages={[reply("m", [todoWrite("t", 1, next)])]}
				phase="running"
			/>,
		);
		expect(statusLine()).toHaveTextContent(/·1\/2·Next:Fix sender$/);
	});

	// The line remounts in the new bubble a read point opens; open is held
	// beside the transcript, so it survives that.
	it("stays open when a read point moves the line to a new bubble", async () => {
		const user = userEvent.setup();
		const first = reply("m", [todoWrite("t", 1, PLAN)]);
		const { rerender } = render(
			<Transcript messages={[first]} phase="running" />,
		);
		await user.click(statusLine());

		const cut: Message[] = [
			{ ...first, status: "complete" },
			{
				id: "u",
				role: "user",
				content: "Also this",
				status: "complete",
				createdAt: new Date(),
			},
			{
				id: "m2",
				role: "assistant",
				parts: [],
				status: "streaming",
				createdAt: new Date(),
				openedAtReadPoint: true,
			},
		];
		rerender(<Transcript messages={cut} phase="running" />);
		const line = statusLine();
		expect(line).toHaveAttribute("aria-expanded", "true");
		expect(inMessage("m2", line)).toBe(true);
	});

	// Only the plan's section goes; what else the reader opened stays open.
	it("keeps the panel open when the agent clears its plan", async () => {
		const user = userEvent.setup();
		const live = agent("a", "Explore", "Find retry handling", "running");
		const { rerender } = render(
			<Transcript
				messages={[reply("m", [todoWrite("t", 1, PLAN), live])]}
				phase="running"
			/>,
		);
		await user.click(statusLine());
		rerender(
			<Transcript
				messages={[
					reply("m", [todoWrite("t", 1, PLAN), live, todoWrite("t2", 2, [])]),
				]}
				phase="running"
			/>,
		);
		expect(statusLine("Working, 1 agent running, details")).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(screen.queryByText(/^Plan · /)).not.toBeInTheDocument();
		expect(entry(/^Explore,/)).toBeInTheDocument();
	});

	// Left open with nothing in it, it would open by itself on the next thing
	// to come — the next thought, around nearly every codex call.
	it("closes when its last section goes", async () => {
		const user = userEvent.setup();
		const messages = [reply("m", [said("t", "Looking.")])];
		const thought = {
			content: "Checking the sender",
			fullReasoning: "",
			joinedLate: false,
		};
		const { rerender } = render(
			<Transcript messages={messages} phase="running" thinking={thought} />,
		);
		await user.click(statusLine("Thinking, details"));
		expect(screen.getByText("Thinking so far")).toBeInTheDocument();

		rerender(<Transcript messages={messages} phase="running" />);
		rerender(
			<Transcript
				messages={messages}
				phase="running"
				thinking={{ ...thought, content: "Next thought" }}
			/>,
		);
		expect(statusLine("Thinking, details")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	});

	it("starts closed in the next turn, and on another session", async () => {
		const user = userEvent.setup();
		const messages = [reply("m", [todoWrite("t", 1, PLAN)])];
		const { rerender } = render(
			<Transcript messages={messages} phase="running" />,
		);
		await user.click(statusLine());
		rerender(
			<Transcript messages={messages} phase="running" sessionId="other" />,
		);
		expect(statusLine()).toHaveAttribute("aria-expanded", "false");

		await user.click(statusLine());
		rerender(
			<Transcript
				messages={[reply("m", [todoWrite("t", 1, PLAN)], "complete")]}
				phase="idle"
				sessionId="other"
			/>,
		);
		const next = [
			reply("m", [todoWrite("t", 1, PLAN)], "complete"),
			reply("m2", [todoWrite("t2", 2, PLAN)]),
		];
		rerender(<Transcript messages={next} phase="running" sessionId="other" />);
		expect(statusLine()).toHaveAttribute("aria-expanded", "false");
	});

	it("goes when the turn settles", () => {
		const messages = [reply("m", [todoWrite("t", 1, PLAN)])];
		const { rerender } = render(
			<Transcript messages={messages} phase="running" />,
		);
		expect(statusLine()).toBeInTheDocument();
		rerender(
			<Transcript
				messages={[reply("m", [todoWrite("t", 1, PLAN)], "complete")]}
				phase="idle"
			/>,
		);
		expect(
			screen.queryByRole("button", { name: STATUS }),
		).not.toBeInTheDocument();
	});
});
