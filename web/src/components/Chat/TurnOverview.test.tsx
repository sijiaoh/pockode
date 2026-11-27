import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useAgentsOverview } from "../../hooks/useAgentsOverview";
import { usePlanOverview } from "../../hooks/usePlanOverview";
import { overviewMessageId } from "../../lib/turnOverview";
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
 * The transcript as `useChatMessages` feeds it: the two lines' state held
 * beside the messages, and the slot that draws it worked out from them.
 */
function Transcript({
	messages,
	phase,
	sessionId = "s",
	openTranscript = null,
}: {
	messages: Message[];
	phase: TurnPhase;
	sessionId?: string;
	/** What the chat provides; none, as outside a chat, by default. */
	openTranscript?: OpenSubagentTranscript | null;
}) {
	const open = phase !== "idle" || messages.some((m) => m.status === "sending");
	const agents = useAgentsOverview(messages, open, sessionId);
	const plan = usePlanOverview(messages, open, sessionId);
	const tail = {
		...IDLE_TAIL,
		phase,
		plan,
		agents,
		overviewMessageId: overviewMessageId(
			messages,
			open,
			agents.liveCount > 0 || agents.expanded,
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

// The rows' own buttons are named "Subagent running" by their glyph.
const LINE_NAME = /^(\d+ agents?|No agents) running$/;
const agentsLine = (name: RegExp | string) =>
	screen.getByRole("button", { name });
// The list's entries are the only buttons named after their row.
const entry = (name: RegExp) =>
	within(screen.getByRole("list", { name: "Agents" })).getByRole("button", {
		name,
	});
const toolRow = (id: string) =>
	document.querySelector<HTMLElement>(`[data-tool-use-id="${id}"]`);

describe("the agents line", () => {
	it("counts the live subagents and names the last one, with what it is doing", () => {
		render(<Transcript messages={three("success")} phase="running" />);
		const line = agentsLine("2 agents running");
		expect(line).toHaveAttribute("aria-expanded", "false");
		// The latest live one in transcript order, not whichever moved last.
		expect(line).toHaveTextContent(
			"2 agents running·code-reviewerChecking the 503 path next.",
		);
	});

	// A background wait is when the line is needed most.
	it("stays while the turn is blocked", () => {
		render(<Transcript messages={three()} phase="blocked" />);
		expect(agentsLine("3 agents running")).toBeInTheDocument();
	});

	it("is not drawn while no subagent is live", () => {
		render(
			<Transcript
				messages={[reply("m", [agent("a", "Explore", "x", "success")])]}
				phase="running"
			/>,
		);
		expect(
			screen.queryByRole("button", { name: LINE_NAME }),
		).not.toBeInTheDocument();
	});

	it("opens a list of the live agents, in transcript order", async () => {
		const user = userEvent.setup();
		render(<Transcript messages={three("success")} phase="running" />);
		await user.click(agentsLine("2 agents running"));

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
		await user.click(agentsLine("3 agents running"));
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
		await user.click(agentsLine("3 agents running"));
		await user.click(
			entry(/^Plan, Draft the migration, running, go to its row$/),
		);

		expect(openTranscript).not.toHaveBeenCalled();
		const row = toolRow("c");
		expect(row).toHaveClass("jump-highlight");
		expect(row?.querySelector("button")).toHaveFocus();
	});

	// Nothing moves under a press.
	it("keeps an entry that settles while the list is open, until it is closed", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<Transcript messages={three()} phase="running" />,
		);
		await user.click(agentsLine("3 agents running"));

		rerender(<Transcript messages={three("success")} phase="running" />);
		expect(agentsLine("2 agents running")).toBeInTheDocument();
		// It says it settled: drawn the same, it must not sound live either.
		expect(entry(/^Plan,/)).toHaveAccessibleName(
			"Plan, Draft the migration, succeeded, go to its row",
		);

		await user.click(agentsLine("2 agents running"));
		await user.click(agentsLine("2 agents running"));
		expect(
			within(screen.getByRole("list", { name: "Agents" })).queryByRole(
				"button",
				{ name: /^Plan,/ },
			),
		).not.toBeInTheDocument();
	});

	it("an agent started while the list is open joins it and stays", async () => {
		const user = userEvent.setup();
		const one = [agent("a", "Explore", "Find retry handling", "running")];
		const { rerender } = render(
			<Transcript messages={[reply("m", one)]} phase="running" />,
		);
		await user.click(agentsLine("1 agent running"));

		const two = [...one, agent("d", "Docs", "Update the docs", "running")];
		rerender(<Transcript messages={[reply("m", two)]} phase="running" />);
		const settled = [one[0], agent("d", "Docs", "Update the docs", "success")];
		rerender(<Transcript messages={[reply("m", settled)]} phase="running" />);
		expect(entry(/^Docs,/)).toBeInTheDocument();
	});

	it("says no agents are running when the last one ends with the list open", async () => {
		const user = userEvent.setup();
		const live = [agent("a", "Explore", "x", "running")];
		const { rerender } = render(
			<Transcript messages={[reply("m", live)]} phase="running" />,
		);
		await user.click(agentsLine("1 agent running"));

		const done = [agent("a", "Explore", "x", "success")];
		rerender(<Transcript messages={[reply("m", done)]} phase="running" />);
		expect(agentsLine("No agents running")).toHaveAttribute(
			"aria-expanded",
			"true",
		);

		await user.click(agentsLine("No agents running"));
		expect(
			screen.queryByRole("button", { name: LINE_NAME }),
		).not.toBeInTheDocument();
	});

	// A turn whose background budget ran out goes idle with its tasks going.
	it("moves above the last reply's turn-end row while a subagent outlives the turn, closed", async () => {
		const user = userEvent.setup();
		const parts = [agent("b", "code-reviewer", "Review", "background")];
		const { rerender } = render(
			<Transcript messages={[reply("m", parts)]} phase="running" />,
		);
		await user.click(agentsLine("1 agent running"));

		const later: Message[] = [
			reply("m", parts, "complete"),
			reply("m2", [said("t", "Started the review.")], "complete"),
		];
		rerender(<Transcript messages={later} phase="idle" />);

		const line = agentsLine("1 agent running");
		expect(line).toHaveAttribute("aria-expanded", "false");
		const last = document.querySelector('[data-message-id="m2"]');
		expect(last?.contains(line)).toBe(true);
	});

	it("is drawn in one bubble only", () => {
		const messages: Message[] = [
			// A superseded reply left streaming, and the open one.
			reply("old", [agent("a", "Explore", "x", "running")]),
			reply("m", [agent("b", "Plan", "y", "running")]),
		];
		render(<Transcript messages={messages} phase="running" />);
		expect(screen.getAllByRole("button", { name: LINE_NAME })).toHaveLength(1);
		expect(
			document
				.querySelector('[data-message-id="m"]')
				?.contains(agentsLine("2 agents running")),
		).toBe(true);
	});

	// The line moves into the new turn's bubble, and the list closes with it.
	it("closes the list when the next turn opens, from the send on", async () => {
		const user = userEvent.setup();
		const parts = [agent("b", "code-reviewer", "Review", "background")];
		const settled: Message[] = [reply("m", parts, "complete")];
		const { rerender } = render(<Transcript messages={settled} phase="idle" />);
		await user.click(agentsLine("1 agent running"));

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
		const line = agentsLine("1 agent running");
		expect(line).toHaveAttribute("aria-expanded", "false");
		expect(
			document.querySelector('[data-message-id="p"]')?.contains(line),
		).toBe(true);
	});

	it("closes the list on another session", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<Transcript messages={three()} phase="running" />,
		);
		await user.click(agentsLine("3 agents running"));
		rerender(
			<Transcript messages={three()} phase="running" sessionId="other" />,
		);
		expect(agentsLine("3 agents running")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
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

const planLine = () => screen.getByRole("button", { name: /^Plan, / });

describe("the plan line", () => {
	it("says where the newest plan stands, and stays while the turn is blocked", () => {
		const { rerender } = render(
			<Transcript
				messages={[
					reply("m", [todoWrite("t1", 1, []), todoWrite("t2", 2, PLAN)]),
				]}
				phase="running"
			/>,
		);
		expect(planLine()).toHaveAccessibleName(
			"Plan, 1 of 3 done, now Writing the retry tests",
		);
		expect(planLine()).toHaveTextContent("1/3·Now:Writing the retry tests");

		rerender(
			<Transcript
				messages={[reply("m", [todoWrite("t2", 2, PLAN)])]}
				phase="blocked"
			/>,
		);
		expect(planLine()).toBeInTheDocument();
	});

	it("is drawn above the agents line", () => {
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
		const agents = agentsLine("1 agent running");
		expect(
			planLine().compareDocumentPosition(agents) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("opens the checklist in place, the explanation first, and follows new records", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<Transcript
				messages={[
					reply("m", [todoWrite("t", 1, PLAN, "Tests before the fix.")]),
				]}
				phase="running"
			/>,
		);
		await user.click(planLine());
		expect(planLine()).toHaveAttribute("aria-expanded", "true");
		const slot = planLine().parentElement as HTMLElement;
		const explanation = within(slot).getByText("Tests before the fix.");
		const list = within(slot).getByRole("list");
		expect(
			explanation.compareDocumentPosition(list) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(within(list).getAllByRole("listitem")).toHaveLength(3);

		const done = PLAN.map((s) => ({ ...s, status: "completed" as const }));
		rerender(
			<Transcript
				messages={[
					reply("m", [
						todoWrite("t", 1, PLAN, "Tests before the fix."),
						todoWrite("t2", 2, done),
					]),
				]}
				phase="running"
			/>,
		);
		expect(planLine()).toHaveTextContent("3/3·All done");
		expect(planLine()).toHaveAttribute("aria-expanded", "true");
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
		expect(planLine()).toHaveTextContent("0/2·Now:Write tests+1");
		expect(planLine()).toHaveAccessibleName(
			"Plan, 0 of 2 done, now Write tests and 1 more",
		);

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
		expect(planLine()).toHaveTextContent("1/2·Next:Fix sender");
	});

	// The line remounts in the new bubble a read point opens; open is held
	// beside the transcript, so it survives that.
	it("stays open when a read point moves the line to a new bubble", async () => {
		const user = userEvent.setup();
		const first = reply("m", [todoWrite("t", 1, PLAN)]);
		const { rerender } = render(
			<Transcript messages={[first]} phase="running" />,
		);
		await user.click(planLine());

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
		const line = planLine();
		expect(line).toHaveAttribute("aria-expanded", "true");
		expect(
			document.querySelector('[data-message-id="m2"]')?.contains(line),
		).toBe(true);
	});

	it("starts closed in the next turn, and on another session", async () => {
		const user = userEvent.setup();
		const messages = [reply("m", [todoWrite("t", 1, PLAN)])];
		const { rerender } = render(
			<Transcript messages={messages} phase="running" />,
		);
		await user.click(planLine());
		rerender(
			<Transcript messages={messages} phase="running" sessionId="other" />,
		);
		expect(planLine()).toHaveAttribute("aria-expanded", "false");

		await user.click(planLine());
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
		expect(planLine()).toHaveAttribute("aria-expanded", "false");
	});

	it("goes when the turn settles", () => {
		const messages = [reply("m", [todoWrite("t", 1, PLAN)])];
		const { rerender } = render(
			<Transcript messages={messages} phase="running" />,
		);
		expect(planLine()).toBeInTheDocument();
		rerender(
			<Transcript
				messages={[reply("m", [todoWrite("t", 1, PLAN)], "complete")]}
				phase="idle"
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /^Plan, / }),
		).not.toBeInTheDocument();
	});
});
