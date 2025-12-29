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
			// First call is attach (returns true), second is user message (fails)
			mockState.send.mockReturnValueOnce(true).mockReturnValueOnce(false);
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
		it("shows inline permission request and sends allow response", async () => {
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

			// Permission request now shows inline in message flow
			expect(screen.getByText("Bash")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Allow" }));

			expect(mockState.send).toHaveBeenCalledWith({
				type: "permission_response",
				session_id: "test-session",
				request_id: "req-1",
				choice: "allow",
			});
		});

		it("shows inline permission request and sends deny response", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onMessage?.({
					type: "permission_request",
					request_id: "req-2",
					tool_name: "Edit",
					tool_input: { file_path: "/etc/passwd" },
					tool_use_id: "tool-2",
				});
			});

			expect(screen.getByText("Edit")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Deny" }));

			expect(mockState.send).toHaveBeenCalledWith({
				type: "permission_response",
				session_id: "test-session",
				request_id: "req-2",
				choice: "deny",
			});
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

		it("sends interrupt when Escape pressed during streaming", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			mockState.send.mockClear();

			// Press Escape while streaming
			await user.keyboard("{Escape}");

			expect(mockState.send).toHaveBeenCalledWith({
				type: "interrupt",
				session_id: "test-session",
			});
		});
	});

	describe("ask user question", () => {
		it("shows dialog and sends answer response", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onMessage?.({
					type: "ask_user_question",
					request_id: "q-1",
					questions: [
						{
							question: "Which library?",
							header: "Library",
							options: [
								{ label: "React", description: "UI library" },
								{ label: "Vue", description: "Progressive framework" },
							],
							multiSelect: false,
						},
					],
				});
			});

			expect(screen.getByRole("dialog")).toBeInTheDocument();
			expect(screen.getByText("Which library?")).toBeInTheDocument();

			// Select an option and submit
			await user.click(screen.getByText("React"));
			await user.click(screen.getByRole("button", { name: /Submit/i }));

			expect(mockState.send).toHaveBeenCalledWith({
				type: "question_response",
				session_id: "test-session",
				request_id: "q-1",
				answers: expect.any(Object),
			});
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});
	});

	describe("history replay", () => {
		it("loads and displays history on mount", async () => {
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

			expect(screen.getByText("Hello")).toBeInTheDocument();
			expect(screen.getByText("Hi there!")).toBeInTheDocument();
			expect(screen.getByText("Bash")).toBeInTheDocument();
			await user.click(screen.getByText("Bash"));
			expect(screen.getByText("file.txt")).toBeInTheDocument();
		});
	});
});
