import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../lib/agentOptionsStore";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useSessionStore } from "../../lib/sessionStore";
import { useWorkStore } from "../../lib/workStore";
import type { ServerNotification } from "../../types/message";
import type { Work } from "../../types/work";
import ChatPanel from "./ChatPanel";

// Mock scrollTo (not available in jsdom)
Element.prototype.scrollTo = vi.fn();

// Mock Project overlays to avoid router dependency
vi.mock("../Project", () => ({
	WorkListOverlay: () => <div data-testid="work-list-overlay" />,
	WorkDetailOverlay: () => <div data-testid="work-detail-overlay" />,
	AgentRoleListOverlay: () => <div data-testid="agent-role-list-overlay" />,
	AgentRoleDetailOverlay: () => <div data-testid="agent-role-detail-overlay" />,
}));

// Use vi.hoisted to ensure mockState is available when vi.mock factory runs
const mockState = vi.hoisted(() => ({
	sendMessage: vi.fn(() => Promise.resolve()),
	interrupt: vi.fn(() => Promise.resolve()),
	permissionResponse: vi.fn(() => Promise.resolve()),
	questionResponse: vi.fn(() => Promise.resolve()),
	chatMessagesSubscribe: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(),
	setSessionMode: vi.fn(() => Promise.resolve()),
	setSessionAgentType: vi.fn(() => Promise.resolve()),
	setSessionModel: vi.fn(() => Promise.resolve()),
	setSessionEffort: vi.fn(() => Promise.resolve()),
	startWork: vi.fn(() => Promise.resolve()),
	onNotification: null as ((notification: ServerNotification) => void) | null,
	mockHistory: [] as unknown[],
	mockModel: "",
	mockEffort: "",
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
		markSessionRead: vi.fn(() => Promise.resolve()),
		setSessionMode: mockState.setSessionMode,
		setSessionAgentType: mockState.setSessionAgentType,
		setSessionModel: mockState.setSessionModel,
		setSessionEffort: mockState.setSessionEffort,
		startWork: mockState.startWork,
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
		isSessionResolved: true,
		onUpdateTitle: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockState.sendMessage.mockResolvedValue(undefined);
		mockState.onNotification = null;
		mockState.uuidCounter = 0;
		mockState.mockHistory = [];
		mockState.mockModel = "";
		mockState.mockEffort = "";
		// Default: subscribe returns empty history and ended state
		mockState.chatMessagesSubscribe.mockImplementation(() =>
			Promise.resolve({
				id: "sub-1",
				initial: {
					history: mockState.mockHistory,
					state: "ended",
					mode: "default",
					agent_type: "claude",
					model: mockState.mockModel,
					effort: mockState.mockEffort,
				},
			}),
		);
		mockState.chatMessagesUnsubscribe.mockResolvedValue(undefined);
		useSessionStore.setState({ sessions: [] });
		useWorkStore.getState().reset();
		useAgentRoleStore.getState().reset();
		// Stands in for the one options fetch the app shell does. Only Claude has
		// effort levels here, which is also how an agent without any is expressed.
		useAgentOptionsStore.getState().setModels({
			claude: [
				{ id: "opus", label: "Opus" },
				{ id: "sonnet", label: "Sonnet" },
			],
			codex: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
		});
		useAgentOptionsStore.getState().setEfforts({
			claude: [
				{ id: "low", label: "Low" },
				{ id: "high", label: "High" },
			],
		});
	});

	// Helper to wait for history loading to complete
	const waitForHistoryLoad = async () => {
		await waitFor(() => {
			expect(
				screen.queryByLabelText("Loading conversation"),
			).not.toBeInTheDocument();
		});
	};

	// The work this session runs, as the global subscription would have it.
	const seedWork = (
		overrides: Partial<Work> & Pick<Work, "status">,
		steps?: string[],
	) => {
		useAgentRoleStore.getState().setRoles([
			{
				id: "role-1",
				name: "Engineer",
				role_prompt: "",
				steps,
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
			},
		]);
		useWorkStore.getState().setWorks([
			{
				id: "work-1",
				type: "task",
				agent_role_id: "role-1",
				title: "Ship the status bar",
				session_id: "test-session",
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:00:00Z",
				...overrides,
			},
		]);
	};

	const setWorkStatus = (status: Work["status"]) => {
		act(() => {
			useWorkStore
				.getState()
				.updateWorks((works) => works.map((w) => ({ ...w, status })));
		});
	};

	// A switch hands the panel the destination's id before anything else about the
	// destination is known. Whatever is still on screen belongs to the session the
	// user came from: showing it reads as having opened the wrong chat, and the
	// input would send the next message into it.
	describe("while the destination session is still resolving", () => {
		it("drops the previous session's messages and refuses to send", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<ChatPanel {...defaultProps} sessionId="previous" />,
			);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "Hello");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			expect(screen.getByText("Hello")).toBeInTheDocument();

			rerender(
				<ChatPanel
					{...defaultProps}
					sessionId="destination"
					sessionTitle=""
					isSessionResolved={false}
				/>,
			);

			expect(screen.queryByText("Hello")).not.toBeInTheDocument();
			expect(screen.getByLabelText("Loading conversation")).toBeInTheDocument();
			expect(screen.getByRole("textbox")).toBeDisabled();
			expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();
			// Subscribing now would target a session the connection can't see yet.
			expect(mockState.chatMessagesSubscribe).not.toHaveBeenCalledWith(
				"destination",
				expect.anything(),
			);
			expect(mockState.sendMessage).toHaveBeenCalledTimes(1);
			expect(mockState.sendMessage).not.toHaveBeenCalledWith(
				"destination",
				expect.anything(),
			);
		});

		it("opens the destination once it resolves", async () => {
			const { rerender } = render(
				<ChatPanel
					{...defaultProps}
					sessionId="destination"
					sessionTitle=""
					isSessionResolved={false}
				/>,
			);

			rerender(
				<ChatPanel
					{...defaultProps}
					sessionId="destination"
					sessionTitle="Destination"
				/>,
			);
			await waitForHistoryLoad();

			expect(mockState.chatMessagesSubscribe).toHaveBeenCalledWith(
				"destination",
				expect.anything(),
			);
			expect(screen.getByRole("textbox")).not.toBeDisabled();
		});
	});

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

		// The generic wording alone made "the CLI isn't installed" and "the network
		// dropped" indistinguishable; the server's own reason has to reach the user.
		it("shows the server's reason when send fails", async () => {
			mockState.sendMessage.mockRejectedValueOnce(
				new Error('failed to start claude: exec: "claude": not found in $PATH'),
			);
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hello");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			await waitFor(() => {
				expect(screen.getByText(/not found in \$PATH/)).toBeInTheDocument();
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
					content: "Hello ",
				});
				mockState.onNotification?.({
					type: "text",
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
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-1",
				});
				mockState.onNotification?.({
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
				mockState.onNotification?.({
					type: "error",
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

		it("shows Always Allow button for Codex sessions", async () => {
			const user = userEvent.setup();
			mockState.chatMessagesSubscribe.mockImplementation(() =>
				Promise.resolve({
					id: "sub-1",
					initial: {
						history: [],
						state: "ended",
						mode: "default",
						agent_type: "codex",
						model: "",
					},
				}),
			);
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "permission_request",
					request_id: "req-codex",
					tool_name: "Bash",
					tool_input: { command: "npm test" },
					tool_use_id: "tool-codex",
				});
			});

			expect(
				screen.getByRole("button", { name: "Always Allow" }),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Always Allow" }));

			expect(mockState.permissionResponse).toHaveBeenCalledWith({
				session_id: "test-session",
				request_id: "req-codex",
				tool_use_id: "tool-codex",
				tool_input: { command: "npm test" },
				permission_suggestions: undefined,
				choice: "always_allow",
			});
		});

		it("hides Always Allow button for Claude sessions without permissionSuggestions", async () => {
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "permission_request",
					request_id: "req-claude",
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "tool-claude",
				});
			});

			expect(
				screen.queryByRole("button", { name: "Always Allow" }),
			).not.toBeInTheDocument();
		});

		it("shows inline permission request and sends deny response", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "permission_request",
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
					content: "Hello",
				});
			});
			mockState.interrupt.mockClear();

			// Press Escape while streaming
			await user.keyboard("{Escape}");

			expect(mockState.interrupt).toHaveBeenCalledWith("test-session");
		});

		it("does not interrupt on Escape when input-bar-hiding overlay is active", async () => {
			const user = userEvent.setup();
			const { rerender } = render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const textarea = screen.getByRole("textbox");
			await user.type(textarea, "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			act(() => {
				mockState.onNotification?.({
					type: "text",
					content: "Hello",
				});
			});
			mockState.interrupt.mockClear();

			// Re-render with work-list overlay (hides InputBar)
			rerender(
				<ChatPanel
					{...defaultProps}
					overlay={{ type: "work-list" }}
					onCloseOverlay={vi.fn()}
				/>,
			);

			await user.keyboard("{Escape}");

			expect(mockState.interrupt).not.toHaveBeenCalled();
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

		it("restores the answered form when replaying history", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = [
				{
					type: "ask_user_question",
					request_id: "q-2",
					tool_use_id: "toolu_q_2",
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
				},
				{
					type: "question_response",
					request_id: "q-2",
					answers: { "Which library?": "Vue" },
				},
				{ type: "done" },
			];

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.click(screen.getByRole("button", { name: /Library/ }));

			const chosen = screen.getByRole("radio", {
				name: /Progressive framework/,
			});
			expect(chosen).toBeChecked();
			expect(chosen).toBeDisabled();
		});

		// A cancelled question is persisted with a nil answers map, which the Go
		// encoder strips entirely — so the key is absent, not null.
		it("shows a cancelled question as cancelled when replaying history", async () => {
			mockState.mockHistory = [
				{
					type: "ask_user_question",
					request_id: "q-3",
					tool_use_id: "toolu_q_3",
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
				},
				{ type: "question_response", request_id: "q-3" },
				{ type: "done" },
			];

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(screen.getByText("Cancelled")).toBeInTheDocument();
			expect(screen.queryByText("Answered")).not.toBeInTheDocument();
		});
	});

	describe("engine selector", () => {
		// The subscription result and the session list carry the same model; a
		// fixture that disagreed would only be testing which one landed last.
		const seedSession = (activated: boolean, model = "", effort = "") => {
			mockState.mockModel = model;
			mockState.mockEffort = effort;
			useSessionStore.setState({
				sessions: [
					{
						id: "test-session",
						title: "Test Chat",
						created_at: "2024-01-01T00:00:00Z",
						updated_at: "2024-01-01T00:00:00Z",
						mode: "default",
						agent_type: "claude",
						model,
						effort,
						activated,
						state: "ended",
						needs_input: false,
						unread: false,
					},
				],
			});
		};

		const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
			await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		};

		// Both lists name their empty value "Auto"; the legend above each is what
		// tells them apart, for a screen reader as much as for this test.
		const section = (title: string) =>
			within(screen.getByRole("group", { name: title }));

		// A first turn that failed before the agent said anything leaves messages
		// in the transcript but never started the session, and switching agents is
		// the only way out of it — so the transcript must not be what locks it.
		it("stays switchable when a failed first turn left messages behind", async () => {
			const user = userEvent.setup();
			seedSession(false);
			mockState.mockHistory = [
				{ type: "message", content: "Hello" },
				{ type: "error", error: "Invalid API key" },
			];

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);

			expect(screen.getByRole("radio", { name: /Codex/ })).toBeEnabled();
		});

		// Only the agent half locks: the server takes a new model at any point in a
		// session's life, and that is the choice someone mid-conversation reaches for.
		it("locks the agent once it has answered, leaving the model changeable", async () => {
			const user = userEvent.setup();
			seedSession(true);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);

			// Only the agent it is stuck with is listed: a third section made the
			// scroll expensive, and an unselectable alternative buys nothing.
			expect(screen.getByRole("radio", { name: /Claude/ })).toBeDisabled();
			expect(
				screen.queryByRole("radio", { name: /Codex/ }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("Agent is locked once the session starts"),
			).toBeInTheDocument();
			expect(screen.getByRole("radio", { name: "Sonnet" })).toBeEnabled();
			expect(
				screen.getByText("Switching restarts the CLI. History is kept."),
			).toBeInTheDocument();
		});

		it("shows the session's model on the chip and sends the new one", async () => {
			const user = userEvent.setup();
			seedSession(false, "opus");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.getByRole("button", { name: "Engine: Claude, Opus" }),
			).toBeInTheDocument();

			await openPanel(user);
			await user.click(screen.getByRole("radio", { name: "Sonnet" }));

			expect(mockState.setSessionModel).toHaveBeenCalledWith(
				"test-session",
				"sonnet",
			);
		});

		// A radio group selects as the arrow keys move through it, so closing on
		// selection would leave a keyboard user able to reach only the option next
		// to the current one.
		it("stays open after a model is picked", async () => {
			const user = userEvent.setup();
			seedSession(false);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);
			await user.click(screen.getByRole("radio", { name: "Sonnet" }));

			expect(screen.getByRole("radio", { name: "Opus" })).toBeInTheDocument();
		});

		// The reason is reported outside the panel, which the drawer covers below
		// the expanded tier — so a refused switch has to get out of the way.
		it("closes on a refused switch so the reason is not covered", async () => {
			const user = userEvent.setup();
			seedSession(false);
			mockState.setSessionModel.mockRejectedValueOnce(new Error("nope"));

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);
			await user.click(screen.getByRole("radio", { name: "Sonnet" }));

			await waitFor(() => {
				expect(
					screen.queryByRole("radio", { name: "Opus" }),
				).not.toBeInTheDocument();
			});
			expect(await screen.findByRole("alert")).toBeInTheDocument();
		});

		// The empty model is the server's "let the CLI decide"; "Auto" is this
		// layer's name for it and has to survive the round trip as an empty string.
		it("sends the empty model for Auto", async () => {
			const user = userEvent.setup();
			seedSession(false, "opus");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);
			await user.click(section("Model").getByRole("radio", { name: /^Auto/ }));

			expect(mockState.setSessionModel).toHaveBeenCalledWith(
				"test-session",
				"",
			);
		});

		// The one fetch is not retried until the socket reconnects, so a failed
		// list would otherwise leave the model unchangeable — not even back to
		// Auto, which this layer names on its own and needs no list to offer.
		it("still offers Auto and the current model when the list failed to load", async () => {
			const user = userEvent.setup();
			seedSession(false, "opus-4");
			useAgentOptionsStore.setState({
				models: null,
				efforts: null,
				error: "request timed out",
			});

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);

			expect(
				screen.getByText(/Couldn't load the engine options: request timed out/),
			).toBeInTheDocument();
			expect(screen.getByRole("radio", { name: "opus-4" })).toBeChecked();
			// One error line for both lists — they are one fetch as far as the panel
			// is concerned — and the effort rows survive it for the same reason the
			// model rows do: Auto is this layer's own constant.
			expect(
				section("Effort").getByRole("radio", { name: /^Auto/ }),
			).toBeInTheDocument();
			expect(
				screen.queryAllByText(/Couldn't load the engine options/),
			).toHaveLength(1);

			await user.click(section("Model").getByRole("radio", { name: /^Auto/ }));

			expect(mockState.setSessionModel).toHaveBeenCalledWith(
				"test-session",
				"",
			);
		});

		// A session keeps a model the server has since stopped offering. Rewriting
		// it to Auto would misreport what the session will actually run.
		it("shows a model the server no longer lists as itself", async () => {
			seedSession(false, "opus-4");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.getByRole("button", { name: "Engine: Claude, opus-4" }),
			).toBeInTheDocument();
		});

		// Switching is a deliberate act whose only other feedback is the control
		// snapping back. Without the server's reason, "that model is not this
		// agent's" and "the connection dropped" look identical.
		it("shows the server's reason when a model switch is refused", async () => {
			const user = userEvent.setup();
			seedSession(false);
			mockState.setSessionModel.mockRejectedValueOnce(
				new Error('model not available for this agent type: model "sonnet"'),
			);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);
			await user.click(screen.getByRole("radio", { name: "Sonnet" }));

			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent("Failed to change model");
			expect(alert).toHaveTextContent("model not available");

			// The chip keeps reporting what the session is still set to.
			expect(
				screen.getByRole("button", { name: "Engine: Claude, Auto" }),
			).toBeInTheDocument();
		});

		// Non-Auto only, and inside the model's truncation budget rather than
		// beside it: on a narrow action bar there is room for one of the two, and
		// the model is the session's identity while the effort is a setting.
		it("shows the effort next to the model on the chip", async () => {
			seedSession(false, "opus", "high");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.getByRole("button", {
					name: "Engine: Claude, Opus, High effort",
				}),
			).toBeInTheDocument();
			expect(screen.getByText("· High")).toBeInTheDocument();
		});

		// Auto has no value to report: what the CLI then picks is its own business.
		it("leaves the chip alone while the effort is Auto", async () => {
			seedSession(false, "opus");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.getByRole("button", { name: "Engine: Claude, Opus" }),
			).toBeInTheDocument();
		});

		// The two are one string on the chip, so a level named from a list that has
		// not arrived would flash its raw id beside a model that waited properly.
		it("waits for both names before showing either on the chip", async () => {
			seedSession(false, "", "high");
			useAgentOptionsStore.setState({
				models: null,
				efforts: null,
				error: null,
			});

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.getByRole("button", { name: "Engine: Claude, loading" }),
			).toBeInTheDocument();
		});

		it("sends the picked effort, and the empty one for Auto", async () => {
			const user = userEvent.setup();
			seedSession(false, "opus", "high");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);

			await user.click(section("Effort").getByRole("radio", { name: "Low" }));
			expect(mockState.setSessionEffort).toHaveBeenCalledWith(
				"test-session",
				"low",
			);

			await user.click(section("Effort").getByRole("radio", { name: /^Auto/ }));
			expect(mockState.setSessionEffort).toHaveBeenCalledWith(
				"test-session",
				"",
			);
		});

		// The levels belong to the agent, so switching agents has to swap the list
		// — and an agent the server lists no levels for has to say so rather than
		// leave a control that does nothing, or a gap at the bottom of a panel
		// whose end nobody scrolls to.
		it("says so when the chosen agent has no effort setting", async () => {
			const user = userEvent.setup();
			seedSession(false);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);

			expect(
				section("Effort").getByRole("radio", { name: "High" }),
			).toBeInTheDocument();

			await user.click(screen.getByRole("radio", { name: /Codex/ }));

			expect(
				await screen.findByText("Codex has no effort setting."),
			).toBeInTheDocument();
			expect(section("Effort").queryByRole("radio")).not.toBeInTheDocument();
		});

		// The server drops a level the new agent cannot take, but until that lands
		// the session really is still set to one — and hiding it behind "no effort
		// setting" would leave the one value that needs clearing unreachable.
		it("keeps a level the agent no longer offers visible and clearable", async () => {
			const user = userEvent.setup();
			seedSession(false, "", "high");

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);
			await user.click(screen.getByRole("radio", { name: /Codex/ }));

			expect(
				screen.queryByText("Codex has no effort setting."),
			).not.toBeInTheDocument();
			expect(
				section("Effort").getByRole("radio", { name: "high" }),
			).toBeChecked();

			await user.click(section("Effort").getByRole("radio", { name: /^Auto/ }));
			expect(mockState.setSessionEffort).toHaveBeenCalledWith(
				"test-session",
				"",
			);
		});

		// Whether this agent has effort levels at all is not yet known, and every
		// way of showing that would be inventing an answer.
		it("hides the effort section until the lists arrive", async () => {
			const user = userEvent.setup();
			seedSession(false);
			useAgentOptionsStore.setState({
				models: null,
				efforts: null,
				error: null,
			});

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);

			expect(screen.getByText("Loading models…")).toBeInTheDocument();
			expect(
				screen.queryByRole("group", { name: "Effort" }),
			).not.toBeInTheDocument();
		});

		// Switching is a deliberate act whose only other feedback is the control
		// snapping back, and the server's reason is what tells a refused level
		// apart from a dropped connection.
		it("shows the server's reason when an effort switch is refused", async () => {
			const user = userEvent.setup();
			seedSession(false);
			mockState.setSessionEffort.mockRejectedValueOnce(
				new Error("effort not available for this agent type"),
			);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			await openPanel(user);
			await user.click(section("Effort").getByRole("radio", { name: "High" }));

			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent("Failed to change effort");
			expect(alert).toHaveTextContent("effort not available");
		});

		it("reports a refused mode switch the same way", async () => {
			const user = userEvent.setup();
			seedSession(false);
			mockState.setSessionMode.mockRejectedValueOnce(new Error("no such mode"));

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.click(screen.getByRole("button", { name: "Default" }));
			await user.click(screen.getByRole("button", { name: /YOLO/ }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Failed to change mode: no such mode",
			);
		});
	});

	// The top bar is the authoritative view of whether the task is still alive:
	// it reads the live work store, never the transcript, so an interrupt shows up
	// here immediately even in a session the user never scrolled up in.
	describe("linked work status", () => {
		it("shows the work status and step alongside the title", async () => {
			seedWork({ status: "in_progress", current_step: 1 }, ["a", "b", "c"]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.getByRole("button", {
					name: "In Progress, Ship the status bar, Step 2/3",
				}),
			).toBeInTheDocument();
		});

		it("follows the work store when the work is stopped", async () => {
			seedWork({ status: "in_progress", current_step: 1 }, ["a", "b", "c"]);

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			setWorkStatus("stopped");

			expect(
				screen.getByRole("button", { name: /^Stopped, Ship the status bar/ }),
			).toBeInTheDocument();
		});

		it("omits the step when the role defines none", async () => {
			seedWork({ status: "in_progress", current_step: 0 });

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const button = screen.getByRole("button", {
				name: /Ship the status bar/,
			});
			expect(button).toBeInTheDocument();
			expect(button).not.toHaveTextContent(/Step/);
		});

		it("opens the work detail when clicked", async () => {
			const user = userEvent.setup();
			const onOpenWorkDetail = vi.fn();
			seedWork({ status: "waiting", current_step: 0 }, ["a", "b"]);

			render(
				<ChatPanel {...defaultProps} onOpenWorkDetail={onOpenWorkDetail} />,
			);
			await waitForHistoryLoad();

			await user.click(
				screen.getByRole("button", { name: /Ship the status bar/ }),
			);

			expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
		});

		it("shows nothing when no work is linked to the session", async () => {
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.queryByRole("button", { name: /Ship the status bar/ }),
			).not.toBeInTheDocument();
		});
	});

	// A work's life and its chat process are two separate clocks. The bug this
	// guards against is reading one off the other: an interrupt stops the work
	// without emitting any message, so a transcript that infers "still going"
	// from its last banner is lying, and it lies exactly when the user most needs
	// the truth.
	describe("when a work and its chat process end at different times", () => {
		const emit = (...notifications: ServerNotification[]) => {
			act(() => {
				for (const n of notifications) mockState.onNotification?.(n);
			});
		};

		const autoContinue: ServerNotification = {
			type: "message",
			content: "Your session went idle but the work is still in_progress.",
			origin: "system",
			subtype: "auto_continue",
			meta: {
				work_id: "work-1",
				work_type: "task",
				title: "Ship the status bar",
				step: { current: 2, total: 3 },
			},
		};

		const card = (name: RegExp) => screen.getByRole("button", { name });

		it("states the interrupt on the card, the strip and the turn, each in its own terms", async () => {
			seedWork({ status: "in_progress", current_step: 1 }, ["a", "b", "c"]);
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// The nudge that used to be the last thing in the transcript, reading
			// like "I just started it up again".
			emit(autoContinue);
			// The user interrupts before the agent writes a word.
			emit({ type: "interrupted" });

			// The turn speaks only for the agent's output.
			expect(screen.getByText("Interrupted")).toBeInTheDocument();
			// The server takes a settle delay before it stops the work, and until it
			// does, neither card nor strip pretends to know. Nothing spins meanwhile:
			// in_progress is a resting state here, not a turn in flight.
			expect(card(/^Task, In Progress, Step 2\/3/)).toBeInTheDocument();
			expect(
				screen.queryByRole("status", { name: "Loading" }),
			).not.toBeInTheDocument();

			setWorkStatus("stopped");

			expect(card(/^Task, Stopped, Step 2\/3/)).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Restart" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /^Stopped, Ship the status bar/ }),
			).toBeInTheDocument();
			// The auto-continue is history now, folded into the card rather than
			// left at the tail of the transcript speaking for the task.
			expect(screen.getAllByRole("button", { name: /^Task, / })).toHaveLength(
				1,
			);
			expect(screen.getByText("Interrupted")).toBeInTheDocument();
		});

		it("lets the chat keep streaming after the work has closed", async () => {
			seedWork({ status: "in_progress", current_step: 1 }, ["a", "b", "c"]);
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			emit(autoContinue, { type: "text", content: "wrapping up" });

			setWorkStatus("closed");

			expect(card(/^Task, Closed, 3\/3/)).toBeInTheDocument();
			// The turn is untouched by the work reaching its end: still streaming,
			// still spinning, still showing what the agent wrote.
			expect(screen.getByText("wrapping up")).toBeInTheDocument();
			expect(
				screen.getByRole("status", { name: "Loading" }),
			).toBeInTheDocument();
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
