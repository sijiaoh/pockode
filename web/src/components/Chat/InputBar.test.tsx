import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInputStore } from "../../lib/inputStore";
import InputBar from "./InputBar";

const TEST_SESSION_ID = "test-session";

describe("InputBar", () => {
	afterEach(() => {
		useInputStore.setState({ inputs: {} });
	});

	it("disables input when disabled prop is true", () => {
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} disabled />);

		expect(screen.getByRole("textbox")).toBeDisabled();
		expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
	});

	it("calls onSend with trimmed input when button clicked", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), "  Hello World  ");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(onSend).toHaveBeenCalledWith("Hello World");
	});

	it("clears input after sending", async () => {
		const user = userEvent.setup();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		const textarea = screen.getByRole("textbox");
		await user.type(textarea, "Test message");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(textarea).toHaveValue("");
	});

	it("sends on Enter", async () => {
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Enter test" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		expect(onSend).toHaveBeenCalledWith("Enter test");
	});

	it("does not send on Shift+Enter (newline)", async () => {
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Shift+Enter test" } });
		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send empty messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.click(screen.getByRole("button", { name: /Send/ }));
		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not send whitespace-only messages", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<InputBar sessionId={TEST_SESSION_ID} onSend={onSend} />);

		await user.type(screen.getByRole("textbox"), "   ");
		await user.click(screen.getByRole("button", { name: /Send/ }));

		expect(onSend).not.toHaveBeenCalled();
	});

	it("shows Stop button when streaming", () => {
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={() => {}}
				isStreaming
				onInterrupt={() => {}}
			/>,
		);

		expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Send/ }),
		).not.toBeInTheDocument();
	});

	it("calls onInterrupt when Stop button clicked", async () => {
		const user = userEvent.setup();
		const onInterrupt = vi.fn();
		render(
			<InputBar
				sessionId={TEST_SESSION_ID}
				onSend={() => {}}
				isStreaming
				onInterrupt={onInterrupt}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /Stop/ }));

		expect(onInterrupt).toHaveBeenCalled();
	});

	it("preserves input across re-renders with same sessionId", () => {
		const { rerender } = render(
			<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "preserved text" } });

		rerender(<InputBar sessionId={TEST_SESSION_ID} onSend={() => {}} />);

		expect(textarea).toHaveValue("preserved text");
	});

	it("maintains separate input state per session", () => {
		const { rerender } = render(
			<InputBar sessionId="session-1" onSend={() => {}} />,
		);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "session 1 text" } });

		rerender(<InputBar sessionId="session-2" onSend={() => {}} />);
		expect(textarea).toHaveValue("");

		fireEvent.change(textarea, { target: { value: "session 2 text" } });

		rerender(<InputBar sessionId="session-1" onSend={() => {}} />);
		expect(textarea).toHaveValue("session 1 text");
	});
});
