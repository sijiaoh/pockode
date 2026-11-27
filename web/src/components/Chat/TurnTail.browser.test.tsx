import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PlanStep, ToolRun } from "../../types/message";
import TurnTail from "./TurnTail";
import { ToolJumpContext } from "./toolJumpContext";
import { IDLE_TAIL, TurnTailContext } from "./turnTailContext";

const nextFrame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const steps: PlanStep[] = Array.from({ length: 14 }, (_, index) => ({
	text: `Step ${index}`,
	status: index < 12 ? "completed" : index === 12 ? "in_progress" : "pending",
	activeText: "Writing the retry tests for the relay's reconnect path",
}));

const agent = (id: string): ToolRun => ({
	id,
	name: "Agent",
	input: { description: "Find retry handling", subagent_type: "Explore" },
	status: "running",
});

// The widest the line gets: the longest label, an hour's clock, two-digit
// counts, and the jump beside the toggle.
function Line({ width, waits = true }: { width: number; waits?: boolean }) {
	return (
		<div data-testid="column" style={{ width }}>
			<ToolJumpContext value={{ reveal: null, goToCall: () => {} }}>
				<TurnTailContext
					value={{
						...IDLE_TAIL,
						phase: "running",
						openedAt: Date.now() - (72 * 60_000 + 5_000),
						overviewMessageId: "m",
						plan: { order: 1, steps },
						agents: {
							liveCount: 3,
							named: agent("c"),
							entries: [],
						},
					}}
				>
					<TurnTail
						messageId="m"
						writing
						placeholder={false}
						awaitedFetch={
							waits ? { id: "f", originToolUseId: "t", waits: true } : undefined
						}
					/>
				</TurnTailContext>
			</ToolJumpContext>
		</div>
	);
}

/**
 * Drawn whole: none of its text cut, and none of it past `right` — the edge
 * of the box it belongs in.
 */
function expectWhole(element: Element, right: number) {
	expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
	const rect = element.getBoundingClientRect();
	expect(rect.width).toBeGreaterThan(0);
	expect(rect.right).toBeLessThanOrEqual(right + 0.5);
}

describe("the status line", () => {
	// docs/turn-progress-ui.md#23-what-it-says: the free text gives way first,
	// then the label; the clock and the chips never do.
	it.each([
		320, 360,
	])("keeps the clock and both counts whole on one line at %ipx", async (width) => {
		render(<Line width={width} />);
		await act(nextFrame);
		const column = screen.getByTestId("column").getBoundingClientRect();
		const toggle = screen.getByRole("button", { name: /details$/ });

		const jump = screen.getByRole("button", { name: "Go to call being read" });
		// Inside the toggle's box, short of its 8px padding, and so clear of the
		// jump beside it.
		const box = toggle.getBoundingClientRect();
		for (const text of ["1h 12m", "12/14", "3"]) {
			expectWhole(screen.getByText(text), box.right - 8);
		}
		expect(jump.getBoundingClientRect().left).toBeGreaterThanOrEqual(box.right);
		expectWhole(jump, column.right);

		const words = toggle.querySelector("[aria-hidden]") as HTMLElement;
		const lineHeight = Number.parseFloat(getComputedStyle(words).lineHeight);
		expect(words.getBoundingClientRect().height).toBeLessThanOrEqual(
			lineHeight + 1,
		);
		// The toggle keeps the line's height: one line, not wrapped.
		expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(44);

		// No `·` left dangling after the last count: the free text's own goes
		// with it.
		const last = screen.getByText("3").getBoundingClientRect().right;
		for (const dot of screen.getAllByText("·")) {
			if (dot.getBoundingClientRect().left < last) continue;
			const clip = (dot.parentElement as HTMLElement).getBoundingClientRect();
			expect(clip.right).toBeLessThanOrEqual(
				dot.getBoundingClientRect().left + 0.5,
			);
		}
	});

	// The agent's title gives way only once what it is doing has, and then
	// with an ellipsis rather than cut off.
	it("cuts the agent's title last, and visibly", async () => {
		const run: ToolRun = {
			...agent("a"),
			input: {
				description: "Review",
				subagent_type: "a-very-long-custom-reviewer-agent-name-for-testing",
			},
			children: [
				{
					type: "tool_call",
					id: "call-r",
					tool: {
						id: "r",
						name: "Read",
						input: { file_path: "/w/server/relay/sender.go" },
						status: "running",
					},
				},
			],
		};
		render(
			<div style={{ width: 320 }}>
				<TurnTailContext
					value={{
						...IDLE_TAIL,
						phase: "blocked",
						overviewMessageId: "m",
						agents: { liveCount: 1, named: run, entries: [] },
					}}
				>
					<TurnTail messageId="m" writing placeholder={false} />
				</TurnTailContext>
			</div>,
		);
		await act(nextFrame);
		const title = screen.getByText(/^a-very-long/);
		const free = title.parentElement as HTMLElement;
		expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
		expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
		// Shrunk to fit, not run on under the clip.
		expect(title.getBoundingClientRect().right).toBeLessThanOrEqual(
			free.getBoundingClientRect().right + 0.5,
		);
	});

	// The free text gives way first, but only to what it has to: with room,
	// it is drawn whole.
	it("draws the free text whole where there is room", async () => {
		render(<Line width={640} waits={false} />);
		await act(nextFrame);
		const toggle = screen.getByRole("button", { name: /details$/ });
		expectWhole(
			screen.getByText(steps[12].activeText as string),
			toggle.getBoundingClientRect().right - 8,
		);
		expectWhole(
			screen.getByText("Working"),
			toggle.getBoundingClientRect().right,
		);
	});
});
