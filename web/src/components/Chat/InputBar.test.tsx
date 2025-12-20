import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import InputBar from "./InputBar";

describe("InputBar", () => {
	it("renders textarea and send button", () => {
		render(<InputBar onSend={() => {}} />);

		expect(
			screen.getByPlaceholderText("Type a message..."),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
	});

	it("disables input when disabled prop is true", () => {
		render(<InputBar onSend={() => {}} disabled />);

		expect(screen.getByPlaceholderText("Type a message...")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
	});

	it("calls onSend with trimmed input when button clicked", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar onSend={onSend} />);

		const textarea = screen.getByPlaceholderText("Type a message...");
		await user.type(textarea, "  Hello World  ");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend).toHaveBeenCalledWith("Hello World");
	});

	it("clears input after sending", async () => {
		const user = userEvent.setup();
		render(<InputBar onSend={() => {}} />);

		const textarea = screen.getByPlaceholderText("Type a message...");
		await user.type(textarea, "Test message");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(textarea).toHaveValue("");
	});

	it("sends on Enter key (without Shift)", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar onSend={onSend} />);

		const textarea = screen.getByPlaceholderText("Type a message...");
		await user.type(textarea, "Enter test");
		await user.keyboard("{Enter}");

		expect(onSend).toHaveBeenCalledWith("Enter test");
	});

	it("does not send on Shift+Enter", async () => {
		const onSend = vi.fn();
		render(<InputBar onSend={onSend} />);

		const textarea = screen.getByPlaceholderText("Type a message...");
		fireEvent.change(textarea, { target: { value: "Multi-line" } });
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send empty messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar onSend={onSend} />);

		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send whitespace-only messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar onSend={onSend} />);

		const textarea = screen.getByPlaceholderText("Type a message...");
		await user.type(textarea, "   ");
		await user.click(screen.getByRole("button", { name: "Send" }));

		expect(onSend).not.toHaveBeenCalled();
	});
});
