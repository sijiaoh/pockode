import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WSServerMessage } from "../../types/message";
import ChatPanel from "./ChatPanel";

// Mock scrollTo (not available in jsdom)
Element.prototype.scrollTo = vi.fn();

// Mock state - stored in module scope for vi.mock factory access
const mockState = {
	send: vi.fn(() => true),
	onMessage: null as ((message: WSServerMessage) => void) | null,
	uuidCounter: 0,
};

vi.mock("../../hooks/useWebSocket", () => ({
	useWebSocket: (options: { onMessage: (msg: WSServerMessage) => void }) => {
		mockState.onMessage = options.onMessage;
		return {
			status: "connected",
			send: mockState.send,
			disconnect: vi.fn(),
		};
	},
}));

vi.mock("../../utils/uuid", () => ({
	generateUUID: () => `uuid-${++mockState.uuidCounter}`,
}));

const mockGetHistory = vi.fn((): Promise<unknown[]> => Promise.resolve([]));
vi.mock("../../lib/sessionApi", () => ({
	getHistory: () => mockGetHistory(),
}));

describe("ChatPanel", () => {
	const defaultProps = {
		sessionId: "test-session",
		sessionTitle: "Test Chat",
		onUpdateTitle: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockState.send.mockReturnValue(true);
		mockState.onMessage = null;
		mockState.uuidCounter = 0;
		mockGetHistory.mockResolvedValue([]);
	});

	// Helper to wait for history loading to complete
	const waitForHistoryLoad = async () => {
		await waitFor(() => {
			expect(screen.getByRole("textbox")).not.toBeDisabled();
		});
	};

	describe("sending messages", () => {
		it("sends message to WebSocket with session_id", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hello AI");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(mockState.send).toHaveBeenCalledWith({
				type: "message",
				content: "Hello AI",
				session_id: "test-session",
			});
			expect(screen.getByText("Hello AI")).toBeInTheDocument();
		});

		it("updates title on first message when title is 'New Chat'", async () => {
			const user = userEvent.setup();
			const onUpdateTitle = vi.fn();
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle="New Chat"
					onUpdateTitle={onUpdateTitle}
				/>,
			);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "My first message");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(onUpdateTitle).toHaveBeenCalledWith("My first message");
		});

		it("shows error when send fails", async () => {
			mockState.send.mockReturnValueOnce(false);
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hello");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(screen.getByText("Failed to send message")).toBeInTheDocument();
		});
	});

	describe("receiving messages", () => {
		it("accumulates streaming text into assistant message", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			act(() => {
				mockState.onMessage?.({ type: "text", content: "Hello " });
				mockState.onMessage?.({ type: "text", content: "there!" });
			});

			expect(screen.getByText("Hello there!")).toBeInTheDocument();
		});

		it("displays tool calls with results", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "List files");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			act(() => {
				mockState.onMessage?.({
					type: "tool_call",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				});
				mockState.onMessage?.({
					type: "tool_result",
					tool_use_id: "tool-1",
					tool_result: "file1.txt",
				});
			});

			expect(screen.getByText("Bash")).toBeInTheDocument();
			// Result visible after expanding
			await user.click(screen.getByText("Bash"));
			expect(screen.getByText("file1.txt")).toBeInTheDocument();
		});

		it("shows error message from server", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			act(() => {
				mockState.onMessage?.({ type: "error", error: "Something went wrong" });
			});

			expect(screen.getByText("Something went wrong")).toBeInTheDocument();
		});
	});

	describe("permission requests", () => {
		it("shows dialog and sends allow response", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onMessage?.({
					type: "permission_request",
					request_id: "req-1",
					tool_name: "Bash",
					tool_input: { command: "rm -rf /" },
					tool_use_id: "tool-1",
				});
			});

			expect(screen.getByRole("dialog")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Allow" }));

			expect(mockState.send).toHaveBeenCalledWith({
				type: "permission_response",
				session_id: "test-session",
				request_id: "req-1",
				choice: "allow",
			});
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});
	});

	describe("interrupt", () => {
		it("sends interrupt when Stop clicked", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			mockState.send.mockClear();

			await user.click(screen.getByRole("button", { name: /Stop/ }));

			expect(mockState.send).toHaveBeenCalledWith({
				type: "interrupt",
				session_id: "test-session",
			});
		});
	});

	describe("history replay", () => {
		it("replays history with text and tool calls", async () => {
			const user = userEvent.setup();
			mockGetHistory.mockResolvedValue([
				{ type: "message", content: "Hello" },
				{ type: "text", content: "Hi there!" },
				{
					type: "tool_call",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				},
				{ type: "tool_result", tool_use_id: "tool-1", tool_result: "file.txt" },
				{ type: "done" },
			]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// User message displayed
			expect(screen.getByText("Hello")).toBeInTheDocument();
			// Assistant text displayed
			expect(screen.getByText("Hi there!")).toBeInTheDocument();
			// Tool call displayed
			expect(screen.getByText("Bash")).toBeInTheDocument();
			// Expand tool to see result
			await user.click(screen.getByText("Bash"));
			expect(screen.getByText("file.txt")).toBeInTheDocument();
		});

		it("replays multiple conversation turns", async () => {
			mockGetHistory.mockResolvedValue([
				{ type: "message", content: "First question" },
				{ type: "text", content: "First answer" },
				{ type: "done" },
				{ type: "message", content: "Second question" },
				{ type: "text", content: "Second answer" },
				{ type: "done" },
			]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(screen.getByText("First question")).toBeInTheDocument();
			expect(screen.getByText("First answer")).toBeInTheDocument();
			expect(screen.getByText("Second question")).toBeInTheDocument();
			expect(screen.getByText("Second answer")).toBeInTheDocument();
		});

		it("handles incomplete assistant message without done event", async () => {
			// Simulates abnormal end: assistant was responding but crashed,
			// then user sent another message
			mockGetHistory.mockResolvedValue([
				{ type: "message", content: "First question" },
				{ type: "text", content: "Partial answer..." },
				// No "done" event - abnormal end
				{ type: "message", content: "Second question" },
				{ type: "text", content: "Complete answer" },
				{ type: "done" },
			]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// Both conversations should be visible
			expect(screen.getByText("First question")).toBeInTheDocument();
			expect(screen.getByText("Partial answer...")).toBeInTheDocument();
			expect(screen.getByText("Second question")).toBeInTheDocument();
			expect(screen.getByText("Complete answer")).toBeInTheDocument();
		});

		it("replays system message as standalone before user message", async () => {
			const user = userEvent.setup();
			mockGetHistory.mockResolvedValue([
				{ type: "system", content: "Welcome! Please login." },
				{ type: "message", content: "Hello" },
				{ type: "text", content: "Hi there!" },
				{ type: "done" },
			]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// System message is standalone (expand to see content)
			await user.click(screen.getByText("system"));
			expect(screen.getByText("Welcome! Please login.")).toBeInTheDocument();
			// Subsequent conversation works
			expect(screen.getByText("Hello")).toBeInTheDocument();
			expect(screen.getByText("Hi there!")).toBeInTheDocument();
		});

		it("separates consecutive server responses after done", async () => {
			// Two separate assistant responses without user messages in between
			mockGetHistory.mockResolvedValue([
				{ type: "text", content: "First response" },
				{ type: "done" },
				{ type: "text", content: "Second response" },
				{ type: "done" },
			]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// Both should be visible as separate messages
			expect(screen.getByText("First response")).toBeInTheDocument();
			expect(screen.getByText("Second response")).toBeInTheDocument();
		});
	});
});
