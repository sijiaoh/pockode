import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	LiveThinking,
	TurnTail as TurnTailValue,
} from "../../lib/thinking";
import TurnTail from "./TurnTail";
import { IDLE_TAIL, TurnTailContext } from "./turnTailContext";

const thinking = (overrides: Partial<LiveThinking> = {}): LiveThinking => ({
	content: "",
	fullReasoning: "",
	joinedLate: false,
	expanded: false,
	...overrides,
});

function renderTail(
	tail: Partial<TurnTailValue>,
	{ placeholder = false, writing = true } = {},
) {
	return render(
		<TurnTailContext value={{ ...IDLE_TAIL, phase: "running", ...tail }}>
			<TurnTail writing={writing} placeholder={placeholder} />
		</TurnTailContext>,
	);
}

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

	// Claude's signal carries no text, so there is nothing to open.
	it("says Thinking… with nothing to open before there is text", () => {
		renderTail({ thinking: thinking() });
		expect(screen.getByText("Thinking…")).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	it("shows the latest line and opens on the text so far", async () => {
		const user = userEvent.setup();
		const onToggleThinking = vi.fn();
		const { rerender } = renderTail({
			thinking: thinking({ content: "**Plan**\n\nChecking how it retries" }),
			onToggleThinking,
		});
		expect(screen.getByText("Checking how it retries")).toBeInTheDocument();

		const line = screen.getByRole("button", {
			name: "Agent's thinking so far",
		});
		expect(line).toHaveAttribute("aria-expanded", "false");
		await user.click(line);
		expect(onToggleThinking).toHaveBeenCalledOnce();

		rerender(
			<TurnTailContext
				value={{
					...IDLE_TAIL,
					phase: "running",
					thinking: thinking({
						content: "**Plan**\n\nChecking how it retries",
						joinedLate: true,
						expanded: true,
					}),
				}}
			>
				<TurnTail writing placeholder={false} />
			</TurnTailContext>,
		);
		expect(line).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Plan")).toBeInTheDocument();
		// The deltas before this client subscribed are gone, and it says so.
		expect(
			screen.getByText("Earlier thinking appears in full when it finishes."),
		).toBeInTheDocument();
	});

	it("hides a thought under way while the turn is blocked", () => {
		renderTail({ phase: "blocked", thinking: thinking({ content: "x" }) });
		expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
	});
});
