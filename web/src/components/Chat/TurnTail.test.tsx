import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	LiveThinking,
	TurnTail as TurnTailValue,
} from "../../lib/thinking";
import type { AwaitedFetch, ToolRun, ToolRunPlan } from "../../types/message";
import TurnTail from "./TurnTail";
import { ToolJumpContext } from "./toolJumpContext";
import { IDLE_TAIL, TurnTailContext } from "./turnTailContext";

const thinking = (overrides: Partial<LiveThinking> = {}): LiveThinking => ({
	content: "",
	fullReasoning: "",
	...overrides,
});

function renderTail(
	tail: Partial<TurnTailValue>,
	{
		placeholder = false,
		writing = true,
		awaitedFetch,
		goToCall = () => {},
	}: {
		placeholder?: boolean;
		writing?: boolean;
		awaitedFetch?: AwaitedFetch;
		goToCall?: (toolUseId: string) => void;
	} = {},
) {
	return render(
		<ToolJumpContext value={{ reveal: null, goToCall }}>
			<TurnTailContext
				value={{
					...IDLE_TAIL,
					phase: "running",
					overviewMessageId: "m",
					...tail,
				}}
			>
				<TurnTail
					messageId="m"
					writing={writing}
					placeholder={placeholder}
					awaitedFetch={awaitedFetch}
				/>
			</TurnTailContext>
		</ToolJumpContext>,
	);
}

const statusLine = () => screen.getByRole("button", { name: /details$/ });

describe("TurnTail", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// Inserted empty and filled a moment later: a live region that arrives
	// with its text already in it is often not read out at all.
	it("says the turn is working, and announces only that", () => {
		vi.useFakeTimers();
		renderTail({});
		expect(screen.getByText("Working")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("");

		act(() => {
			vi.advanceTimersByTime(100);
		});
		expect(screen.getByRole("status")).toHaveTextContent("Agent is running");
	});

	// A blocked turn is not producing; the attention strip says what holds it.
	it("draws nothing while the turn is blocked", () => {
		renderTail({ phase: "blocked", openedAt: Date.now() - 60_000 });
		expect(screen.queryByText("Working")).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("");
	});

	it("stands for the turn a placeholder is about to open, without a clock", () => {
		renderTail({ phase: "idle" }, { placeholder: true });
		expect(screen.getByText("Working")).toBeInTheDocument();
	});

	it("counts the turn's clock every second from when the turn opened", () => {
		vi.useFakeTimers();
		renderTail({ openedAt: Date.now() - 63_500 });
		expect(screen.getByText("1m 3s")).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("1m 4s")).toBeInTheDocument();
	});

	it("shows no number under three seconds", () => {
		vi.useFakeTimers();
		renderTail({ openedAt: Date.now() - 2000 });
		expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("3s")).toBeInTheDocument();
	});

	describe("while the agent waits on a fetch with no row", () => {
		const awaitedFetch: AwaitedFetch = {
			id: "f1",
			originToolUseId: "t1",
			waits: true,
		};

		it("says it is waiting, and goes to the row the fetch reads", async () => {
			const user = userEvent.setup();
			const goToCall = vi.fn();
			renderTail({}, { awaitedFetch, goToCall });
			expect(screen.getByText("Waiting for output…")).toBeInTheDocument();

			await user.click(
				screen.getByRole("button", { name: "Go to call being read" }),
			);
			expect(goToCall).toHaveBeenCalledWith("t1");
		});

		it("says reading for a fetch that does not wait", () => {
			renderTail({}, { awaitedFetch: { ...awaitedFetch, waits: false } });
			expect(screen.getByText("Reading output…")).toBeInTheDocument();
		});

		// Thinking that started after the fetch is the newer word.
		it("gives way to thinking", () => {
			renderTail({ thinking: thinking() }, { awaitedFetch });
			expect(screen.getByText("Thinking…")).toBeInTheDocument();
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
		});
	});

	// Claude's signal carries no text, so there is nothing to open.
	it("says Thinking… with nothing to open before there is text", () => {
		renderTail({ thinking: thinking() });
		expect(screen.getByText("Thinking…")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows the latest line and opens on the text so far", async () => {
		const user = userEvent.setup();
		const onToggle = vi.fn();
		const value = (expanded: boolean) => ({
			thinking: thinking({
				content: "**Plan**\n\nChecking how it retries",
			}),
			panel: { expanded, onToggle },
		});
		const { rerender } = renderTail(value(false));
		expect(screen.getByText("Checking how it retries")).toBeInTheDocument();

		const line = screen.getByRole("button", { name: "Thinking, details" });
		expect(line).toHaveAttribute("aria-expanded", "false");
		await user.click(line);
		expect(onToggle).toHaveBeenCalledOnce();

		rerender(
			<ToolJumpContext value={{ reveal: null, goToCall: () => {} }}>
				<TurnTailContext
					value={{ ...IDLE_TAIL, phase: "running", ...value(true) }}
				>
					<TurnTail messageId="m" writing placeholder={false} />
				</TurnTailContext>
			</ToolJumpContext>,
		);
		expect(line).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Thinking so far")).toBeInTheDocument();
		expect(screen.getByText("Plan")).toBeInTheDocument();
	});

	// The clock follows the word, where a changing latest line cannot push it
	// around: `Thinking… 12s` reads like the `Thought for 12s` it settles into.
	it("puts the clock after the word and before the latest line", () => {
		vi.useFakeTimers();
		renderTail({
			openedAt: Date.now() - 64_000,
			thinking: thinking({ content: "Checking how it retries" }),
		});
		expect(
			screen.getByRole("button", { name: "Thinking, details" }),
		).toHaveTextContent(/^Thinking…1m 4s·Checking how it retries$/);
	});

	it("hides a thought under way while the turn is blocked", () => {
		renderTail({ phase: "blocked", thinking: thinking({ content: "x" }) });
		expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
	});

	describe("with a plan and agents", () => {
		const PLAN = {
			order: 1,
			steps: [
				{
					text: "Write tests",
					activeText: "Writing tests",
					status: "in_progress",
				},
				{ text: "Fix it", status: "pending" },
			],
		} satisfies ToolRunPlan;
		const named: ToolRun = {
			id: "a",
			name: "Agent",
			input: { description: "Find it", subagent_type: "Explore" },
			status: "running",
		};
		const agents = { liveCount: 1, named, entries: [] };

		// The plan moves least: codex switches between working and thinking
		// around nearly every call.
		it("says the plan's words over the thinking, and the thinking over the agent", () => {
			const { unmount } = renderTail({
				plan: PLAN,
				agents,
				thinking: thinking({ content: "Checking" }),
			});
			expect(statusLine()).toHaveTextContent(
				/^Thinking…·0\/2·1·Now:Writing tests$/,
			);
			unmount();

			renderTail({ agents, thinking: thinking({ content: "Checking" }) });
			expect(statusLine()).toHaveTextContent(/^Thinking…·1·Checking$/);
		});

		it("names the agent when nothing else has words", () => {
			renderTail({ agents });
			expect(statusLine()).toHaveAccessibleName(
				"Working, 1 agent running, details",
			);
			expect(statusLine()).toHaveTextContent(/^Working·1·Explore$/);
		});

		// The agent named first is the one running the nested one; naming the
		// nested one's agent too left a phone room for neither.
		it("names a nested subagent step by its task alone", () => {
			const outer: ToolRun = {
				id: "o",
				name: "Agent",
				input: { description: "Outer", subagent_type: "general-purpose" },
				status: "running",
				children: [
					{
						type: "tool_call",
						id: "call-n",
						tool: {
							id: "n",
							name: "Agent",
							input: {
								description: "Read README first line",
								subagent_type: "general-purpose",
							},
							status: "running",
						},
					},
				],
			};
			renderTail({ agents: { liveCount: 1, named: outer, entries: [] } });
			expect(statusLine()).toHaveTextContent(
				/^Working·1·general-purposeRead README first line$/,
			);
		});

		// Only the bubble the overview is drawn in counts the turn.
		it("draws no plan or agents in another bubble", () => {
			renderTail({ plan: PLAN, agents, overviewMessageId: "other" });
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
			expect(screen.getByText("Working")).toBeInTheDocument();
		});

		// A button cannot hold a button: the jump stands beside the toggle.
		it("keeps Go to call beside the toggle while it waits", () => {
			renderTail(
				{ plan: PLAN },
				{ awaitedFetch: { id: "f1", originToolUseId: "t1", waits: true } },
			);
			const toggle = statusLine();
			expect(toggle).toHaveAccessibleName(
				"Waiting for output, plan 0 of 2, details",
			);
			const jump = screen.getByRole("button", {
				name: "Go to call being read",
			});
			expect(toggle).not.toContainElement(jump);
		});
	});
});
