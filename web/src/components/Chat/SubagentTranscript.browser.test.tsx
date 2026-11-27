import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	ContentPart,
	Message,
	ToolRun,
} from "../../types/message";
import { SubagentTranscript } from "./SubagentTranscript";

// Where the level opens and how it follows its subagent are measured
// positions, which jsdom has none of (docs/subagent-transcript-ui.md#following-the-live-tail).

const HEIGHT = 400;
let partId = 0;

/** A paragraph a few lines tall, so a handful of them overflow the view. */
const step = (label: string): ContentPart => ({
	type: "text",
	id: `text-${++partId}`,
	content: `${label} ${"lorem ipsum dolor sit amet ".repeat(30)}`,
});

const steps = (count: number, from = 0) =>
	Array.from({ length: count }, (_, i) => step(`Step ${from + i + 1}.`));

const LONG_REPORT = `Report starts here. ${"the sender retries ".repeat(400)}`;

const agent = (run: Partial<ToolRun>): ContentPart => ({
	type: "tool_call",
	id: "call-t1",
	tool: {
		id: "t1",
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

/** A subagent of the first one's, for a level to be drawn over it. */
const nested: ContentPart = {
	type: "tool_call",
	id: "call-t2",
	tool: {
		id: "t2",
		name: "Agent",
		input: { description: "plan it", subagent_type: "Plan", prompt: "Plan." },
		status: "running",
	},
};

const reply = (...parts: ContentPart[]): AssistantMessage => ({
	id: "m1",
	role: "assistant",
	parts,
	status: "complete",
	createdAt: new Date(0),
});

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** One `act` per frame, so what each frame's observers did commits. */
async function settle() {
	for (let i = 0; i < 3; i++) await act(nextFrame);
}

function renderLevel(
	messages: Message[],
	height = HEIGHT,
	initialPath = ["t1"],
) {
	let path = initialPath;
	const ui = (msgs: Message[]) => (
		<div className="relative" style={{ height }}>
			<SubagentTranscript
				messages={msgs}
				path={path}
				onPathChange={vi.fn()}
				escapeHeld={false}
				partProps={{ sessionId: "s1" }}
			/>
		</div>
	);
	const result = render(ui(messages));
	// The outermost level's, which is not on screen while another is over it.
	const scroller = document.querySelector<HTMLElement>(
		'[data-subagent-level="0"]',
	);
	if (!scroller) throw new Error("no level drawn");
	return {
		scroller,
		rerender: async (msgs: Message[], nextPath = path) => {
			path = nextPath;
			result.rerender(ui(msgs));
			await settle();
		},
		/** How far the end is below the view's bottom edge. */
		belowView: () =>
			scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
		/** How far below the view's top edge `text` starts. */
		viewTopOf: (content: string) =>
			screen.getByText(content, { exact: false }).getBoundingClientRect().top -
			scroller.getBoundingClientRect().top,
		scrollUp: async (by: number) => {
			scroller.scrollTop -= by;
			await settle();
		},
	};
}

describe("SubagentTranscript following its subagent in a real layout", () => {
	it("opens a live subagent at its end and keeps up with new steps", async () => {
		const children = steps(8);
		const level = renderLevel([reply(agent({ children }))]);
		await settle();
		expect(level.scroller.scrollHeight).toBeGreaterThan(HEIGHT * 2);
		expect(level.belowView()).toBeLessThanOrEqual(1);

		await level.rerender([
			reply(agent({ children: [...children, ...steps(3, 8)] })),
		]);
		expect(level.belowView()).toBeLessThanOrEqual(1);
		expect(
			screen.queryByRole("button", { name: /Scroll to bottom/ }),
		).not.toBeInTheDocument();
	});

	it("opens a settled subagent on its prompt", async () => {
		const level = renderLevel([
			reply(agent({ children: steps(8), status: "success", result: "Done." })),
		]);
		await settle();
		expect(level.scroller.scrollTop).toBe(0);
		expect(
			level.viewTopOf("Look at server/relay for retries."),
		).toBeGreaterThanOrEqual(0);
		expect(level.viewTopOf("Look at server/relay for retries.")).toBeLessThan(
			60,
		);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeVisible();
	});

	it("reads a short level from the top", async () => {
		const level = renderLevel([reply(agent({ children: steps(1) }))]);
		await settle();
		expect(level.viewTopOf("Look at server/relay for retries.")).toBeLessThan(
			60,
		);
	});

	it("leaves a reader who scrolled away where they are, with the dot, until ↓", async () => {
		const user = userEvent.setup();
		const children = steps(8);
		const level = renderLevel([reply(agent({ children }))]);
		await settle();
		await level.scrollUp(HEIGHT);
		const before = level.viewTopOf("Step 5.");
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeVisible();

		await level.rerender([
			reply(agent({ children: [...children, ...steps(2, 8)] })),
		]);
		expect(level.viewTopOf("Step 5.")).toBeCloseTo(before, 0);
		const button = screen.getByRole("button", {
			name: "Scroll to bottom, new steps",
		});

		await user.click(button);
		await settle();
		expect(level.belowView()).toBeLessThanOrEqual(1);
		// Following again.
		await level.rerender([
			reply(agent({ children: [...children, ...steps(4, 8)] })),
		]);
		expect(level.belowView()).toBeLessThanOrEqual(1);
	});

	it("goes to the report's top when the followed subagent settles, and follows no more", async () => {
		// Short enough that the report's clamp, its label and its buttons are
		// more than the view holds.
		const height = 200;
		const children = steps(4);
		const level = renderLevel([reply(agent({ children }))], height);
		await settle();
		expect(level.belowView()).toBeLessThanOrEqual(1);

		await level.rerender([
			reply(agent({ children, status: "success", result: LONG_REPORT })),
		]);
		const reportTop = level.viewTopOf("Report starts here.");
		expect(reportTop).toBeGreaterThanOrEqual(0);
		expect(reportTop).toBeLessThan(40);
		expect(level.belowView()).toBeGreaterThan(1);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom" }),
		).toBeVisible();
	});

	it("moves nothing when the followed subagent settles with a report that fits", async () => {
		const children = steps(4);
		const level = renderLevel([reply(agent({ children }))]);
		await settle();

		await level.rerender([
			reply(agent({ children, status: "success", result: LONG_REPORT })),
		]);
		expect(level.belowView()).toBeLessThanOrEqual(1);
		expect(level.viewTopOf("Report starts here.")).toBeLessThan(HEIGHT);
	});

	it("does not move a reader who scrolled away when the subagent settles", async () => {
		const children = steps(8);
		const level = renderLevel([reply(agent({ children }))]);
		await settle();
		await level.scrollUp(HEIGHT);
		const before = level.viewTopOf("Step 5.");

		await level.rerender([
			reply(agent({ children, status: "success", result: LONG_REPORT })),
		]);
		expect(level.viewTopOf("Step 5.")).toBeCloseTo(before, 0);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom, new steps" }),
		).toBeVisible();
	});

	it("follows a resumed subagent again from its end", async () => {
		const children = steps(4);
		const settled = agent({
			children,
			status: "success",
			result: "Short report.",
			subagent: { agentId: "a1" },
		});
		const level = renderLevel([reply(settled)]);
		await settle();
		level.scroller.scrollTop = level.scroller.scrollHeight;
		await settle();
		expect(level.belowView()).toBeLessThanOrEqual(1);

		const resume = (status: ToolRun["status"]): ContentPart => ({
			type: "tool_call",
			id: "call-r1",
			tool: { id: "r1", name: "SendMessage", input: { to: "a1" }, status },
		});
		await level.rerender([reply(settled, resume("running"))]);
		const grown = agent({
			children: [...children, ...steps(4, 4)],
			status: "success",
			result: "Short report.",
			subagent: { agentId: "a1" },
		});
		await level.rerender([reply(grown, resume("running"))]);
		expect(level.belowView()).toBeLessThanOrEqual(1);
	});

	it("follows nothing while another level is over it, and shows the dot coming back", async () => {
		const children = [...steps(8), nested];
		const level = renderLevel([reply(agent({ children }))], HEIGHT, [
			"t1",
			"t2",
		]);
		await settle();
		const end = level.scroller.scrollTop;

		await level.rerender([
			reply(agent({ children: [...children, ...steps(3, 8)] })),
		]);
		expect(level.scroller.scrollTop).toBeCloseTo(end, 0);

		await level.rerender(
			[reply(agent({ children: [...children, ...steps(3, 8)] }))],
			["t1"],
		);
		expect(level.belowView()).toBeGreaterThan(1);
		expect(
			screen.getByRole("button", { name: "Scroll to bottom, new steps" }),
		).toBeVisible();
	});

	it("follows on, back on top, when nothing arrived while it was under", async () => {
		const children = [...steps(8), nested];
		const level = renderLevel([reply(agent({ children }))], HEIGHT, [
			"t1",
			"t2",
		]);
		await settle();
		await level.rerender([reply(agent({ children }))], ["t1"]);
		await level.rerender([
			reply(agent({ children: [...children, ...steps(3, 8)] })),
		]);
		expect(level.belowView()).toBeLessThanOrEqual(1);
	});

	it("does not follow a subagent that resumes while another level is over it", async () => {
		const settledNested: ContentPart = {
			...nested,
			tool: { ...nested.tool, status: "success", result: "Planned." },
		} as ContentPart;
		const children = [...steps(8), settledNested];
		const settled = (kids: ContentPart[]) =>
			agent({
				children: kids,
				status: "success",
				result: "Short report.",
				subagent: { agentId: "a1" },
			});
		const resume: ContentPart = {
			type: "tool_call",
			id: "call-r1",
			tool: {
				id: "r1",
				name: "SendMessage",
				input: { to: "a1" },
				status: "running",
			},
		};
		const level = renderLevel([reply(settled(children))]);
		await settle();
		level.scroller.scrollTop = level.scroller.scrollHeight;
		await settle();
		const end = level.scroller.scrollTop;
		await level.rerender([reply(settled(children))], ["t1", "t2"]);

		await level.rerender([reply(settled(children), resume)]);
		await level.rerender([
			reply(settled([...children, ...steps(3, 8)]), resume),
		]);
		expect(level.scroller.scrollTop).toBeCloseTo(end, 0);
	});
});
