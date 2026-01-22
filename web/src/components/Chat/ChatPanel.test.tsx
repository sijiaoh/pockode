import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../types/message";
import ChatPanel from "./ChatPanel";

// Mock scrollTo (not available in jsdom)
Element.prototype.scrollTo = vi.fn();

// Use vi.hoisted to ensure mockState is available when vi.mock factory runs
const mockState = vi.hoisted(() => ({
	sendMessage: vi.fn(() => Promise.resolve()),
	interrupt: vi.fn(() => Promise.resolve()),
	permissionResponse: vi.fn(() => Promise.resolve()),
	questionResponse: vi.fn(() => Promise.resolve()),
	chatMessagesSubscribe: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(),
	onNotification: null as ((notification: ServerNotification) => void) | null,
	mockHistory: [] as unknown[],
	uuidCounter: 0,
}));

vi.mock("../../lib/wsStore", () => {
	const createMockActions = () => ({
		connect: vi.fn(),
		disconnect: vi.fn(),
		sendMessage: mockState.sendMessage,
		interrupt: mockState.interrupt,
		permissionResponse: mockState.permissionResponse,
		questionResponse: mockState.questionResponse,
		chatMessagesSubscribe: (
			_sessionId: string,
			listener: (notification: ServerNotification) => void,
		) => {
			mockState.onNotification = listener;
			return mockState.chatMessagesSubscribe(_sessionId, listener);
		},
		chatMessagesUnsubscribe: mockState.chatMessagesUnsubscribe,
	});

	const mockStore = ((selector: (state: unknown) => unknown) => {
		const state = {
			status: "connected",
			actions: createMockActions(),
		};
		return selector(state);
	}) as unknown as {
		(selector: (state: unknown) => unknown): unknown;
		getState: () => {
			status: string;
			actions: ReturnType<typeof createMockActions>;
		};
	};

	mockStore.getState = () => ({
		status: "connected",
		actions: createMockActions(),
	});

	return { useWSStore: mockStore };
});

vi.mock("../../utils/uuid", () => ({
	generateUUID: () => `uuid-${++mockState.uuidCounter}`,
}));

describe("ChatPanel", () => {
	const defaultProps = {
		sessionId: "test-session",
		sessionTitle: "Test Chat",
		onUpdateTitle: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockState.sendMessage.mockResolvedValue(undefined);
		mockState.onNotification = null;
		mockState.uuidCounter = 0;
		mockState.mockHistory = [];
		// Default: subscribe returns empty history and not running
		mockState.chatMessagesSubscribe.mockImplementation(() =>
			Promise.resolve({
				id: "sub-1",
				initial: { history: mockState.mockHistory, process_running: false },
			}),
		);
		mockState.chatMessagesUnsubscribe.mockResolvedValue(undefined);
	});

	// Helper to wait for history loading to complete
	const waitForHistoryLoad = async () => {
		await waitFor(() => {
			expect(screen.getByRole("textbox")).not.toBeDisabled();
		});
	};

	describe("sending messages", () => {
		it("sends message via RPC with session_id and content", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hello AI");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(mockState.sendMessage).toHaveBeenCalledWith(
				"test-session",
				"Hello AI",
			);
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
			mockState.sendMessage.mockRejectedValueOnce(new Error("Network error"));
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hello");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			await waitFor(() => {
				expect(screen.getByText("Failed to send message")).toBeInTheDocument();
			});
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
				mockState.onNotification?.({
					type: "text",
					session_id: "test-session",
					content: "Hello ",
				});
				mockState.onNotification?.({
					type: "text",
					session_id: "test-session",
					content: "there!",
				});
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
				mockState.onNotification?.({
					type: "tool_call",
					session_id: "test-session",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				});
				mockState.onNotification?.({
					type: "tool_result",
					session_id: "test-session",
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
				mockState.onNotification?.({
					type: "error",
					session_id: "test-session",
					error: "Something went wrong",
				});
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
				mockState.onNotification?.({
					type: "permission_request",
					session_id: "test-session",
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

			expect(mockState.permissionResponse).toHaveBeenCalledWith({
				session_id: "test-session",
				request_id: "req-1",
				tool_use_id: "tool-1",
				tool_input: { command: "rm -rf /" },
				permission_suggestions: undefined,
				choice: "allow",
			});
		});

		it("shows inline permission request and sends deny response", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "permission_request",
					session_id: "test-session",
					request_id: "req-2",
					tool_name: "Edit",
					tool_input: { file_path: "/etc/passwd" },
					tool_use_id: "tool-2",
				});
			});

			expect(screen.getByText("Edit")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Deny" }));

			expect(mockState.permissionResponse).toHaveBeenCalledWith({
				session_id: "test-session",
				request_id: "req-2",
				tool_use_id: "tool-2",
				tool_input: { file_path: "/etc/passwd" },
				permission_suggestions: undefined,
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

			// Simulate receiving text to set isProcessRunning=true (which enables isStreaming)
			act(() => {
				mockState.onNotification?.({
					type: "text",
					session_id: "test-session",
					content: "Hello",
				});
			});
			mockState.interrupt.mockClear();

			await user.click(screen.getByRole("button", { name: /Stop/ }));

			expect(mockState.interrupt).toHaveBeenCalledWith("test-session");
		});

		it("sends interrupt when Escape pressed during streaming", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			// Simulate receiving text to set isProcessRunning=true (which enables isStreaming)
			act(() => {
				mockState.onNotification?.({
					type: "text",
					session_id: "test-session",
					content: "Hello",
				});
			});
			mockState.interrupt.mockClear();

			// Press Escape while streaming
			await user.keyboard("{Escape}");

			expect(mockState.interrupt).toHaveBeenCalledWith("test-session");
		});
	});

	describe("ask user question", () => {
		it("shows inline question and sends answer response", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "ask_user_question",
					session_id: "test-session",
					request_id: "q-1",
					tool_use_id: "toolu_q_1",
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

			// Inline question displays in message flow (no dialog role)
			expect(screen.getByText("Which library?")).toBeInTheDocument();
			// Header "Library" appears both in collapsed view and expanded view
			expect(screen.getAllByText("Library")).toHaveLength(2);

			// Select an option and submit
			await user.click(screen.getByText("React"));
			await user.click(screen.getByRole("button", { name: /Submit/i }));

			expect(mockState.questionResponse).toHaveBeenCalledWith({
				session_id: "test-session",
				request_id: "q-1",
				tool_use_id: "toolu_q_1",
				answers: { "Which library?": "React" },
			});
		});
	});

	describe("history replay", () => {
		it("loads and displays history on mount", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = [
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
			];

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
