import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, UserMessage } from "../../types/message";
import ForkSessionSheet from "./ForkSessionSheet";

const anchor: UserMessage = {
	id: "u1",
	role: "user",
	content: "Refactor the session store",
	status: "complete",
	createdAt: new Date(),
	anchorSeq: 3,
};

const defaultProps = {
	anchor,
	droppedCount: 0,
	agentType: "claude" as const,
	defaultTitle: "Refactor (fork)",
	isForking: false,
	error: null,
	onFork: vi.fn(),
	onClose: vi.fn(),
};

describe("ForkSessionSheet", () => {
	it("echoes the anchor back so the user can confirm what they picked", () => {
		render(<ForkSessionSheet {...defaultProps} />);

		expect(screen.getByText("You")).toBeInTheDocument();
		expect(screen.getByText("Refactor the session store")).toBeInTheDocument();
	});

	it("says how many messages stay behind", () => {
		const { rerender } = render(
			<ForkSessionSheet {...defaultProps} droppedCount={28} />,
		);
		expect(
			screen.getByText(/The 28 messages after it stay in this session/),
		).toBeInTheDocument();

		rerender(<ForkSessionSheet {...defaultProps} droppedCount={1} />);
		expect(
			screen.getByText(/The message after it stays in this session/),
		).toBeInTheDocument();

		rerender(<ForkSessionSheet {...defaultProps} droppedCount={0} />);
		expect(screen.queryByText(/stay(s)? in this session/)).toBeNull();
	});

	it("forks with the edited title", async () => {
		const user = userEvent.setup();
		const onFork = vi.fn();
		render(<ForkSessionSheet {...defaultProps} onFork={onFork} />);

		const input = screen.getByLabelText("Title");
		expect(input).toHaveValue("Refactor (fork)");
		await user.clear(input);
		await user.type(input, "Try the other approach");
		await user.click(screen.getByRole("button", { name: "Fork" }));

		expect(onFork).toHaveBeenCalledWith("Try the other approach");
	});

	// Over a slow link the user must not be able to dismiss the sheet and be
	// left unsure whether a session was created.
	it("locks itself while the fork is in flight", () => {
		render(<ForkSessionSheet {...defaultProps} isForking />);

		expect(screen.getByRole("button", { name: /Forking/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
	});

	it("shows the server's refusal and stays open", () => {
		render(
			<ForkSessionSheet
				{...defaultProps}
				error="fork anchor is outside the session's history: seq 9, the session has 4 records"
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"fork anchor is outside the session's history",
		);
		expect(screen.getByRole("button", { name: "Fork" })).toBeEnabled();
	});

	it("labels the anchor with the agent that produced it", () => {
		const assistant: AssistantMessage = {
			id: "a1",
			role: "assistant",
			parts: [{ type: "text", content: "Here is the plan" }],
			status: "complete",
			createdAt: new Date(),
			anchorSeq: 4,
		};
		render(<ForkSessionSheet {...defaultProps} anchor={assistant} />);

		expect(screen.getByText("Claude")).toBeInTheDocument();
		expect(screen.getByText("Here is the plan")).toBeInTheDocument();
	});
});
