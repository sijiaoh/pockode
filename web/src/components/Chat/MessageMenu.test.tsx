import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, UserMessage } from "../../types/message";
import MessageMenu from "./MessageMenu";

const message: UserMessage = {
	id: "u1",
	role: "user",
	content: "Refactor the session store\nand add tests",
	status: "complete",
	createdAt: new Date(),
	anchorSeq: 3,
};

describe("MessageMenu", () => {
	it("titles itself with the message it acts on", () => {
		render(
			<MessageMenu message={message} onFork={vi.fn()} onClose={vi.fn()} />,
		);

		// One line: the sheet's title truncates, and a newline in it would not.
		expect(
			screen.getByRole("heading", {
				name: "Refactor the session store and add tests",
			}),
		).toBeInTheDocument();
	});

	it("forks from the message", async () => {
		const user = userEvent.setup();
		const onFork = vi.fn();
		render(<MessageMenu message={message} onFork={onFork} onClose={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "Fork from here" }));
		expect(onFork).toHaveBeenCalled();
	});

	// A hidden control teaches the user nothing: an action that cannot apply
	// here says so instead of disappearing.
	it("keeps a blocked fork visible and says why", () => {
		render(
			<MessageMenu
				message={message}
				forkBlockedReason="Codex cannot reopen an earlier conversation, so its sessions cannot be forked."
				onFork={vi.fn()}
				onClose={vi.fn()}
			/>,
		);

		const row = screen.getByRole("button", { name: /Fork from here/ });
		expect(row).toBeDisabled();
		expect(row).toHaveTextContent(
			"Codex cannot reopen an earlier conversation, so its sessions cannot be forked.",
		);
	});

	it("falls back to a title when the message is nothing but a tool call", () => {
		const toolOnly: AssistantMessage = {
			id: "a1",
			role: "assistant",
			parts: [
				{ type: "tool_call", tool: { id: "t1", name: "Bash", input: {} } },
			],
			status: "complete",
			createdAt: new Date(),
			anchorSeq: 4,
		};
		render(
			<MessageMenu message={toolOnly} onFork={vi.fn()} onClose={vi.fn()} />,
		);

		expect(screen.getByRole("heading", { name: "Bash" })).toBeInTheDocument();
	});
});
