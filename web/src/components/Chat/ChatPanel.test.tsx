import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	render as rtlRender,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../lib/agentOptionsStore";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { clearAnswerIntent, requestAnswerPanel } from "../../lib/answerIntent";
import { useInputStore } from "../../lib/inputStore";
import { useQuestionDraftStore } from "../../lib/questionDraftStore";
import { useSessionDetailStore } from "../../lib/sessionDetailStore";
import { useSessionStore } from "../../lib/sessionStore";
import { useWorkStore } from "../../lib/workStore";
import {
	makeSessionDetail,
	makeSessionListItem,
} from "../../test/sessionFixtures";
import type {
	ServerNotification,
	SessionDetail,
	SessionMode,
	SessionTurn,
} from "../../types/message";
import type { AgentType } from "../../types/settings";
import type { WorkListItem } from "../../types/work";
import ChatPanel from "./ChatPanel";

// Mock scrollTo (not available in jsdom)
Element.prototype.scrollTo = vi.fn();

/**
 * The panel reads two things request/response — a viewed session's metadata and
 * its transcript — so it needs a query client whether or not a test exercises
 * them. A fresh client per render keeps one test's cached answer out of the
 * next one.
 */
function render(ui: React.ReactElement) {
	const queryClient = new QueryClient({
		defaultOptions: {
			// `retryDelay`, not `retry`: these reads decide for themselves how many
			// attempts a failure is worth — a refusal none, anything else a few —
			// so switching retries off here would not reach them. Removing the wait
			// between attempts does, and leaves the behaviour under test intact.
			queries: { retry: false, retryDelay: 0 },
		},
	});
	return rtlRender(ui, {
		wrapper: ({ children }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	});
}

// Mocked for the same reason the Project overlays below are: it reads the
// route, and this suite renders no router. The file overlay is the one used
// here that leaves the composer mounted, which is what makes it the honest
// stand-in for "an overlay came and went".
vi.mock("../Files", () => ({
	FileView: () => <div data-testid="file-view" />,
	FileEditor: () => <div data-testid="file-editor" />,
}));

// Mock Project overlays to avoid router dependency
vi.mock("../Project", () => ({
	WorkListOverlay: () => <div data-testid="work-list-overlay" />,
	WorkDetailOverlay: () => <div data-testid="work-detail-overlay" />,
	AgentRoleListOverlay: () => <div data-testid="agent-role-list-overlay" />,
	AgentRoleDetailOverlay: () => <div data-testid="agent-role-detail-overlay" />,
}));

// Use vi.hoisted to ensure mockState is available when vi.mock factory runs
const mockState = vi.hoisted(() => ({
	// Mirrors ChatActions.sendMessage: it resolves with the seq the server gave
	// the message, or undefined when there is no address to give.
	sendMessage: vi.fn(
		(): Promise<number | undefined> => Promise.resolve(undefined),
	),
	interrupt: vi.fn(() => Promise.resolve()),
	permissionResponse: vi.fn(() => Promise.resolve()),
	questionResponse: vi.fn(() => Promise.resolve()),
	chatMessagesSubscribe: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(),
	// Typed as the real actions are: the default implementations, set in
	// beforeEach, answer the way the server does — by pushing the new value back.
	setSessionMode: vi.fn(
		(_sessionId: string, _mode: SessionMode): Promise<void> =>
			Promise.resolve(),
	),
	setSessionAgentType: vi.fn(
		(_sessionId: string, _agentType: AgentType): Promise<void> =>
			Promise.resolve(),
	),
	setSessionModel: vi.fn(
		(_sessionId: string, _model: string): Promise<void> => Promise.resolve(),
	),
	setSessionEffort: vi.fn(
		(_sessionId: string, _effort: string): Promise<void> => Promise.resolve(),
	),
	startWork: vi.fn(() => Promise.resolve()),
	forkSession: vi.fn(),
	// The read-only pair: one session's metadata and one page of its transcript,
	// out of a worktree the connection is not bound to.
	sessionViewGet: vi.fn(),
	sessionViewHistory: vi.fn(),
	/** Whether the server *refused* a read, as opposed to failing to answer. */
	isInvalidParamsRejection: vi.fn(() => false),
	// The agents the server declares. The fork UI here is tested on an agent that
	// can be forked; the refusal has its own test below.
	listAgents: vi.fn(() =>
		Promise.resolve([{ type: "claude", fork_support: "any_message" }]),
	),
	onNotification: null as ((notification: ServerNotification) => void) | null,
	sessionDetail: null as SessionDetail | null,
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
		markSessionRead: vi.fn(() => Promise.resolve()),
		setSessionMode: mockState.setSessionMode,
		setSessionAgentType: mockState.setSessionAgentType,
		setSessionModel: mockState.setSessionModel,
		setSessionEffort: mockState.setSessionEffort,
		startWork: mockState.startWork,
		forkSession: mockState.forkSession,
		listAgents: mockState.listAgents,
		sessionViewGet: mockState.sessionViewGet,
		sessionViewHistory: mockState.sessionViewHistory,
	});

	// One actions object for the whole file, not a fresh one per read: a hook
	// that resubscribes when its subscribe function changes identity — as the
	// session detail subscription does — would never stop.
	const actions = createMockActions();
	const state = { status: "connected", workDir: "", actions };

	const mockStore = ((selector: (state: unknown) => unknown) =>
		selector(state)) as unknown as {
		(selector: (state: unknown) => unknown): unknown;
		getState: () => typeof state;
	};

	mockStore.getState = () => state;

	// Reached by the viewed-session read, which has to tell "not there" from
	// "could not ask".
	return {
		useWSStore: mockStore,
		wsActions: actions,
		isInvalidParamsRejection: mockState.isInvalidParamsRejection,
	};
});

vi.mock("../../utils/uuid", () => ({
	generateUUID: () => `uuid-${++mockState.uuidCounter}`,
}));

/**
 * What `session.detail.subscribe` has put in the store — the only source of the
 * session's agent, model, effort, mode and activation, and of where it was
 * forked from.
 *
 * Written straight to the store because the subscription is the app shell's:
 * whether the session exists is what it answers, and the shell does not mount
 * the panel until it knows (see AppShell). The panel only ever reads.
 */
const seedSessionDetail = (overrides: Partial<SessionDetail> = {}) => {
	mockState.sessionDetail = makeSessionDetail({
		id: "test-session",
		title: "Test Chat",
		...overrides,
	});
	useSessionDetailStore
		.getState()
		.setDetail(mockState.sessionDetail.id, mockState.sessionDetail);
};

/**
 * A setting the server took, arriving the only way one does: as a push on the
 * session's own subscription. Nothing applies a setting locally, so a fake that
 * merely resolved would leave the control showing the old value forever.
 */
// jsdom does not scroll. Where the jump lands is MessageList's own test; here
// it only has to not throw.
Element.prototype.scrollIntoView = vi.fn();

const acceptSetting = (overrides: Partial<SessionDetail>) => {
	if (!mockState.sessionDetail) throw new Error("no session detail seeded");
	mockState.sessionDetail = { ...mockState.sessionDetail, ...overrides };
	useSessionDetailStore
		.getState()
		.setDetail(mockState.sessionDetail.id, mockState.sessionDetail);
};

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
		useSessionDetailStore.getState().clear();
		seedSessionDetail();
		mockState.setSessionMode.mockImplementation(async (_id, mode) =>
			acceptSetting({ mode }),
		);
		mockState.setSessionAgentType.mockImplementation(async (_id, agentType) =>
			acceptSetting({ agent_type: agentType }),
		);
		mockState.setSessionModel.mockImplementation(async (_id, model) =>
			acceptSetting({ model }),
		);
		mockState.setSessionEffort.mockImplementation(async (_id, effort) =>
			acceptSetting({ effort }),
		);
		// Default: subscribe returns empty history and ended state
		mockState.chatMessagesSubscribe.mockImplementation(() =>
			Promise.resolve({
				id: "sub-1",
				initial: {
					history: mockState.mockHistory,
					turn: { phase: "idle", open: false, since: "" },
				},
			}),
		);
		mockState.chatMessagesUnsubscribe.mockResolvedValue(undefined);
		mockState.forkSession.mockReset();
		mockState.isInvalidParamsRejection.mockReturnValue(false);
		mockState.sessionViewGet.mockResolvedValue(
			makeSessionDetail({ id: "test-session", title: "Old Chat" }),
		);
		mockState.sessionViewHistory.mockResolvedValue({
			history: [],
			has_more: false,
		});
		useSessionStore.setState({ sessions: [] });
		useInputStore.setState({ inputs: {} });
		useQuestionDraftStore.setState({ drafts: {}, restorable: {} });
		clearAnswerIntent();
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
		overrides: Partial<WorkListItem> & Pick<WorkListItem, "status">,
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
				activity: "idle",
				session_id: "test-session",
				updated_at: "2024-01-01T00:00:00Z",
				...overrides,
			},
		]);
	};

	const setWorkStatus = (status: WorkListItem["status"]) => {
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

	// The whole answering path, end to end: the strip offers it, the panel sends
	// it, and the card in the transcript settles. The last of those is the one
	// this client has to do itself — the sender is left out of the broadcast
	// that carries its own message, so nothing is coming to settle the card
	// (docs/answering-ui.md §3).
	describe("answering a posted question", () => {
		const question = {
			request_id: "q1",
			header: "Database",
			question: "Which database should I use?",
			options: [
				{ label: "Postgres", description: "Managed" },
				{ label: "SQLite", description: "One file" },
			],
			multi_select: false,
			asked_at: "2026-01-02T14:02:00Z",
		};

		/**
		 * The answer panel. A region rather than a dialog, and deliberately: it
		 * covers the bottom of the transcript and nothing else, so the rest of
		 * the transcript, the composer, the strip and the bars stay usable —
		 * which `aria-modal` would deny.
		 */
		const answerPanel = () => screen.getByRole("region", { name: /question/ });

		const seedUnansweredQuestion = () => {
			mockState.mockHistory = [
				{ type: "message", content: "go", seq: 1 },
				{
					type: "question_posted",
					request_id: "q1",
					questions: [
						{
							question: question.question,
							header: question.header,
							options: question.options,
							multiSelect: false,
						},
					],
					asked_at: question.asked_at,
					seq: 2,
				},
			];
			acceptSetting({
				turn: {
					phase: "idle",
					open: false,
					since: "",
					unanswered: [question],
				},
			});
		};

		/** What a reload leaves behind: a stored draft, not vouched for yet. */
		const seedStoredDraft = (requestId: string) =>
			useQuestionDraftStore.setState({
				restorable: {
					"test-session": {
						[requestId]: {
							labels: ["SQLite"],
							text: "",
							otherPicked: false,
							declined: false,
							note: "",
						},
					},
				},
			});

		// The half of the persistence rule the user sees: what they typed before
		// the reload is on the block again, because the list the page came back to
		// still carries that question (docs/answering-ui.md §5).
		it("puts a stored draft back when the arriving list still carries its question", async () => {
			seedStoredDraft("q1");
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const panel = within(answerPanel());
			expect(panel.getByRole("radio", { name: /SQLite/ })).toBeChecked();
			expect(panel.getByText("1 of 1 ready")).toBeInTheDocument();
		});

		// The other half, and the reason persisting is safe at all: the question
		// was answered or withdrawn while the page was away, so its block never
		// appears and the draft goes without a word.
		it("drops a stored draft the arriving list has no question for", async () => {
			seedStoredDraft("gone");
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await waitFor(() =>
				expect(useQuestionDraftStore.getState().drafts["test-session"]).toEqual(
					{},
				),
			);
			const panel = within(answerPanel());
			expect(panel.getByRole("radio", { name: /SQLite/ })).not.toBeChecked();
		});

		it("shows itself for a waiting question and settles the card in the transcript", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// The card is a record: it says Pending and holds no form.
			expect(screen.getByText("Pending")).toBeInTheDocument();

			// Nothing was pressed to get here. The question is on screen because
			// it is waiting, which is the whole of the rule.
			expect(answerPanel()).toBeInTheDocument();
			// And the app put it there, so the caret is left where it was.
			expect(answerPanel()).not.toHaveFocus();

			// Scoped to the panel: the composer below it has a Send of its own.
			const panel = within(answerPanel());
			await user.click(panel.getByRole("radio", { name: /SQLite/ }));
			await user.click(panel.getByRole("button", { name: "Send" }));

			expect(mockState.sendMessage).toHaveBeenCalledWith(
				"test-session",
				"Answering:\n\nQ: Which database should I use?\nA: SQLite",
				[{ request_id: "q1", answers: ["SQLite"] }],
			);
			expect(await screen.findByText("Answered")).toBeInTheDocument();
			expect(screen.queryByText("Pending")).not.toBeInTheDocument();
		});

		// Nothing was written and nothing was delivered, so the transcript must
		// look exactly as it did — no phantom message, no error bubble under it.
		it("takes its echo back when the server refuses the whole message", async () => {
			const user = userEvent.setup();
			mockState.sendMessage.mockRejectedValueOnce(
				new Error(
					"that question is not waiting for an answer: q1 (answered by the user at 14:05)",
				),
			);
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			const panel = within(answerPanel());
			await user.click(panel.getByRole("radio", { name: /SQLite/ }));
			await user.click(panel.getByRole("button", { name: "Send" }));

			expect(
				await screen.findByText("Already answered elsewhere."),
			).toBeInTheDocument();
			expect(screen.queryByText("Answering:")).not.toBeInTheDocument();
			expect(screen.getByText("Pending")).toBeInTheDocument();
		});

		// The one thing that makes this a panel and not the full-screen drawer it
		// used to be: it stops at the bottom of the transcript's rectangle.
		it("does not reach the composer", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(answerPanel()).toBeInTheDocument();

			// Not merely present: usable, and used. The Send picked here is the
			// composer's — the panel has one of its own, which is the point.
			await user.type(screen.getByRole("textbox"), "meanwhile");
			const composerSend = screen
				.getAllByRole("button", { name: /^Send/ })
				.filter((button) => !answerPanel().contains(button));
			expect(composerSend).toHaveLength(1);
			await user.click(composerSend[0]);
			expect(mockState.sendMessage).toHaveBeenCalledWith(
				"test-session",
				"meanwhile",
				undefined,
			);
			expect(answerPanel()).toBeInTheDocument();
		});

		// The panel leaves the top of the transcript showing, and what is showing
		// has to be usable: an `inert` over it would tell a screen reader that
		// controls the user can plainly see are not there. The card's own
		// `Answer this` is the case that proves it — with the panel already up it
		// is no longer a way in but a way to *this one*, and it still works.
		it("leaves the transcript under it live", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(answerPanel()).toBeInTheDocument();
			expect(screen.getByText("Pending").closest("[inert]")).toBeNull();

			// Nothing named a question, so the panel showed itself without taking
			// the caret; pressing the card's button is a naming, and that does.
			expect(answerPanel()).not.toHaveFocus();
			const card = screen
				.getAllByRole("button", { name: /Database/ })
				.find((button) => !answerPanel().contains(button));
			if (!card) throw new Error("no question card in the transcript");
			await user.click(card);
			await user.click(screen.getByRole("button", { name: "Answer this" }));
			expect(answerPanel()).toHaveFocus();
		});

		// The panel's own height is what the transcript keeps its tail above, and
		// it has to leave with the panel. The inset comes from the same
		// expression that decides the panel is drawn at all, rather than from a
		// state cleared by hand: four separate acts close this panel, and the one
		// that forgot to clear would leave a strip of blank transcript under it
		// for the rest of the visit (docs/answering-ui.md §3).
		it("holds the transcript's tail above itself, and lets go on closing", async () => {
			const user = userEvent.setup();
			// jsdom lays nothing out, so the one number the panel reports has to be
			// supplied; its own descriptor goes back afterwards rather than being
			// deleted, which would leave later tests without `offsetHeight` at all.
			const offsetHeight = Object.getOwnPropertyDescriptor(
				HTMLElement.prototype,
				"offsetHeight",
			);
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
				configurable: true,
				get: () => 300,
			});

			try {
				seedUnansweredQuestion();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				// The transcript's scroller, told apart from the panel's own by
				// which of the two contains it. Neither carries a role.
				const transcriptScroller = () => {
					const el = Array.from(
						document.querySelectorAll<HTMLElement>(".overflow-y-auto"),
					).find((candidate) => !answerPanel().contains(candidate));
					if (!el) throw new Error("no transcript scroller");
					return el;
				};
				expect(transcriptScroller().style.paddingBottom).toBe("300px");

				const scroller = transcriptScroller();
				await user.click(
					within(answerPanel()).getByRole("button", { name: "Close" }),
				);
				expect(
					screen.queryByRole("region", { name: /question/ }),
				).not.toBeInTheDocument();
				expect(scroller.style.paddingBottom).toBe("0px");
			} finally {
				if (offsetHeight) {
					Object.defineProperty(
						HTMLElement.prototype,
						"offsetHeight",
						offsetHeight,
					);
				} else {
					Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
				}
			}
		});

		// The panel is the strip's second row, said in full. Closing gives the row
		// back, and its Answer button is the one way back in — there is no second
		// button anywhere.
		it("trades the strip's question row for the panel, and back", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(
				screen.queryByText("1 question is waiting for your answer."),
			).not.toBeInTheDocument();

			await user.click(
				within(answerPanel()).getByRole("button", { name: "Close" }),
			);
			expect(
				screen.queryByRole("region", { name: /question/ }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText("1 question is waiting for your answer."),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Answer" }));
			expect(answerPanel()).toBeInTheDocument();
		});

		// Whether the panel is open is held, never read off the unanswered list.
		// Derived, it would vanish in the frame the last question is answered from
		// another tab — taking a half-typed answer with it.
		it("stays up when the last question is answered from somewhere else", async () => {
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() =>
				acceptSetting({
					turn: {
						phase: "idle",
						open: false,
						since: "",
						unanswered: [],
					},
				}),
			);

			expect(answerPanel()).toBeInTheDocument();
			expect(screen.getByText("Nothing left to answer.")).toBeInTheDocument();
		});

		// The panel stays up when a permission request arrives over it — nothing
		// vanishes under the user's hand. But the card the strip offers to jump
		// to carries Allow, Deny and the tool input under them, so it wants the
		// whole rectangle rather than whatever the panel leaves over; the jump
		// closes the panel, which costs nothing but a tap on `Answer`.
		it("gets out of the way of a jump to a covered request", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "permission_request",
					request_id: "req-9",
					tool_name: "Edit",
					tool_input: { file_path: "/etc/hosts" },
					tool_use_id: "tool-9",
				});
			});
			act(() =>
				acceptSetting({
					turn: {
						phase: "blocked",
						open: true,
						since: "2024-01-01T00:00:00Z",
						blockers: [
							{
								kind: "permission",
								request_id: "req-9",
								raised_at: "2024-01-01T00:00:00Z",
							},
						],
						unanswered: [question],
					},
				}),
			);
			// The panel is not what closes under a permission request.
			expect(answerPanel()).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Jump to request" }));

			expect(
				screen.queryByRole("region", { name: /question/ }),
			).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
		});

		// The panel outlives an overlay, but the tap that opened it does not:
		// coming back from a file or a diff is the app re-showing the panel, and
		// an automatic re-show must not pull the caret out of the composer.
		it("stops taking focus once an overlay has been through", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			const { rerender } = render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// Asked for by hand, so it is read out: close it and press Answer.
			await user.click(
				within(answerPanel()).getByRole("button", { name: "Close" }),
			);
			await user.click(screen.getByRole("button", { name: "Answer" }));
			expect(answerPanel()).toHaveFocus();

			rerender(
				<ChatPanel
					{...defaultProps}
					overlay={{ type: "file", path: "a.ts" }}
				/>,
			);
			rerender(<ChatPanel {...defaultProps} />);

			// Back, because closing it was never asked for — but it is the app
			// that brought it back, so the caret stays where the user left it.
			expect(answerPanel()).toBeInTheDocument();
			expect(answerPanel()).not.toHaveFocus();
		});

		// The work detail is an overlay over this very panel, so its `Answer` on a
		// question of the session already on screen navigates nowhere but out of
		// the overlay. The intent still has to be read, or that entry point does
		// nothing at all.
		it("opens on the question the work detail named, with no session switch", async () => {
			seedUnansweredQuestion();
			const { rerender } = render(
				<ChatPanel
					{...defaultProps}
					overlay={{ type: "work-detail", workId: "w1", segment: "current" }}
				/>,
			);
			await waitForHistoryLoad();

			requestAnswerPanel({ sessionId: "test-session", requestId: "q1" });
			rerender(<ChatPanel {...defaultProps} />);

			expect(answerPanel()).toBeInTheDocument();
			// A user action, so it is read out rather than left to be noticed.
			expect(answerPanel()).toHaveFocus();
		});

		// A posted question does not block the turn, so nothing about sending is
		// refused while one is open.
		it("leaves the composer alone", async () => {
			const user = userEvent.setup();
			seedUnansweredQuestion();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "an ordinary message");
			// The panel has a Send of its own; this one is the composer's.
			await user.click(
				screen
					.getAllByRole("button", { name: /^Send/ })
					.filter((button) => !answerPanel().contains(button))[0],
			);

			// It answers nothing: no `answering`, and the card stays Pending.
			expect(mockState.sendMessage).toHaveBeenCalledWith(
				"test-session",
				"an ordinary message",
				undefined,
			);
			expect(screen.getByText("Pending")).toBeInTheDocument();
		});

		// Closing says "not now", and it is worth exactly that: this one stretch
		// of looking at this chat. An unanswered question is where the work has
		// stopped, so going away and coming back puts it back on screen — the
		// rule is one sentence and takes no exceptions, least of all for the
		// overlays that sit right on top of the chat (docs/answering-ui.md §4).
		describe("after the user closes it", () => {
			const closeThePanel = async (
				user: ReturnType<typeof userEvent.setup>,
			) => {
				await user.click(
					within(answerPanel()).getByRole("button", { name: "Close" }),
				);
				expect(
					screen.queryByRole("region", { name: /question/ }),
				).not.toBeInTheDocument();
			};

			it("stays closed for the rest of this visit", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				await closeThePanel(user);

				// The same list arriving again is not a new question, and must not
				// undo what the user just did.
				act(() =>
					acceptSetting({
						turn: {
							phase: "idle",
							open: false,
							since: "",
							unanswered: [question],
						},
					}),
				);
				expect(
					screen.queryByRole("region", { name: /question/ }),
				).not.toBeInTheDocument();
				expect(
					screen.getByText("1 question is waiting for your answer."),
				).toBeInTheDocument();
			});

			// A question that arrived while the panel was up has been shown, so the
			// close covers it too. Counting only what was there when the panel
			// opened would put the panel straight back up on the next render.
			it("stays closed over a question that arrived while it was up", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				act(() =>
					acceptSetting({
						turn: {
							phase: "idle",
							open: false,
							since: "",
							unanswered: [
								question,
								{ ...question, request_id: "q2", header: "Cache" },
							],
						},
					}),
				);
				expect(within(answerPanel()).getByText("Cache")).toBeInTheDocument();

				await closeThePanel(user);
				expect(
					screen.queryByRole("region", { name: /question/ }),
				).not.toBeInTheDocument();
			});

			it("comes back after a look at another session", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				const { rerender } = render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				await closeThePanel(user);

				rerender(<ChatPanel {...defaultProps} sessionId="elsewhere" />);
				await waitForHistoryLoad();
				rerender(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				expect(answerPanel()).toBeInTheDocument();
			});

			it("comes back after an overlay over the transcript", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				const { rerender } = render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				await closeThePanel(user);

				rerender(
					<ChatPanel
						{...defaultProps}
						overlay={{ type: "file", path: "a.ts" }}
					/>,
				);
				rerender(<ChatPanel {...defaultProps} />);

				expect(answerPanel()).toBeInTheDocument();
				// Brought back by the app, so it does not take the caret.
				expect(answerPanel()).not.toHaveFocus();
			});

			it("comes back when the work list leads back into the session", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				const { rerender } = render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				await closeThePanel(user);

				// The way in from a work item or a notification: an overlay closes
				// and the session changes in the same step.
				rerender(
					<ChatPanel
						{...defaultProps}
						sessionId="elsewhere"
						overlay={{ type: "work-list", segment: "current" }}
					/>,
				);
				rerender(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				expect(answerPanel()).toBeInTheDocument();
			});

			it("comes back after a reload", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				const { unmount } = render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				await closeThePanel(user);

				// A reload keeps nothing of this: the flag is memory, and memory is
				// what the page just threw away.
				unmount();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				expect(answerPanel()).toBeInTheDocument();
			});

			it("comes back for a question it has not shown before", async () => {
				const user = userEvent.setup();
				seedUnansweredQuestion();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				await closeThePanel(user);

				act(() =>
					acceptSetting({
						turn: {
							phase: "idle",
							open: false,
							since: "",
							unanswered: [
								question,
								{ ...question, request_id: "q2", header: "Cache" },
							],
						},
					}),
				);

				// "Not now" was said about what was on screen at the time. This one
				// was not.
				expect(answerPanel()).toBeInTheDocument();
			});
		});

		// The server refuses an answer while a permission request is outstanding,
		// so a panel opened over one could only be typed into and then turned
		// away. The strip's first row is what has to be dealt with first.
		describe("while a permission request is waiting", () => {
			const blockOnPermission = () =>
				acceptSetting({
					turn: {
						phase: "blocked",
						open: true,
						since: "2024-01-01T00:00:00Z",
						blockers: [
							{
								kind: "permission",
								request_id: "req-9",
								raised_at: "2024-01-01T00:00:00Z",
							},
						],
						unanswered: [question],
					},
				});

			it("does not show itself", async () => {
				seedUnansweredQuestion();
				blockOnPermission();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				expect(
					screen.queryByRole("region", { name: /question/ }),
				).not.toBeInTheDocument();
			});

			it("shows itself as soon as the permission is dealt with", async () => {
				seedUnansweredQuestion();
				blockOnPermission();
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();

				act(() =>
					acceptSetting({
						turn: {
							phase: "idle",
							open: false,
							since: "",
							unanswered: [question],
						},
					}),
				);

				expect(answerPanel()).toBeInTheDocument();
			});
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

			// An ordinary message answers nothing, so the third argument is absent.
			expect(mockState.sendMessage).toHaveBeenCalledWith(
				"test-session",
				"Hello AI",
				undefined,
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

	// "A turn is open" stopped being a reason to refuse: both CLIs steer the
	// running turn with what arrives mid-reply. What refuses now is a request
	// owning the agent's next line of input — the server refuses those too, and
	// sending over one used to hang the turn for good (docs/lifecycle-ui.md §2.3).
	describe("sending while the agent is working", () => {
		const setTurn = (
			phase: SessionTurn["phase"],
			blockers?: SessionTurn["blockers"],
		) =>
			act(() => {
				acceptSetting({
					turn: {
						phase,
						open: phase !== "idle",
						since: "2024-01-01T00:00:00Z",
						blockers,
					},
				});
			});

		const permission = {
			kind: "permission" as const,
			request_id: "p1",
			raised_at: "2024-01-01T00:00:00Z",
		};
		const background = {
			kind: "background" as const,
			raised_at: "2024-01-01T00:00:00Z",
		};

		it.each<[string, SessionTurn["phase"], SessionTurn["blockers"]]>([
			["running", "running", undefined],
			["blocked on background work", "blocked", [background]],
		])("sends while the turn is %s", async (_label, phase, blockers) => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			setTurn(phase, blockers);

			await user.type(screen.getByRole("textbox"), "Also look at X");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(mockState.sendMessage).toHaveBeenCalledWith(
				"test-session",
				"Also look at X",
				undefined,
			);
		});

		// Stop stays on screen throughout: sending into a turn is not an
		// alternative to ending it, and the two controls sit in different rows.
		it("keeps Stop alongside Send", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			setTurn("running");
			await user.type(screen.getByRole("textbox"), "Also look at X");

			expect(screen.getByRole("button", { name: /Send/ })).toBeEnabled();
			expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
		});

		// A permission request is the one thing left that owns the agent's next line
		// of input. A posted question does not: the agent carried on working, so the
		// composer stays live and the answer travels as an ordinary message.
		it("refuses while a permission request owns the input", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();
			setTurn("blocked", [permission]);

			await user.type(screen.getByRole("textbox"), "never mind");
			expect(screen.getByRole("button", { name: /Send/ })).toBeDisabled();

			// A disabled control with no reason on screen is a silent failure.
			expect(
				screen.getByText(/Answer above or Stop before sending\./),
			).toBeInTheDocument();
			expect(mockState.sendMessage).not.toHaveBeenCalled();
		});

		// The optimistic half of `turnOpen` covers the round trip between pressing
		// send and the server reporting `running`. A second message typed inside
		// that same round trip is appended below the placeholder rather than making
		// one of its own, so a check that only looked at the end of the transcript
		// would take Stop away exactly when the user has sent twice and most needs
		// it.
		it("keeps Stop through a second send made before the server answers", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "first");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();

			// Still no word from the server: the turn is reported idle throughout.
			await user.type(screen.getByRole("textbox"), "second");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
		});

		// There is no placeholder for a mid-turn send to fail in, and a refusal is
		// reachable — the server refuses one sent while a permission or question is
		// waiting, and the request can be raised in the moment between the check and
		// the send. The message must not be left looking delivered.
		it("reports a refused mid-turn send under the message it refused", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			setTurn("running");
			act(() => {
				mockState.onNotification?.({ type: "text", content: "Working on it" });
			});

			// Held open so the transcript can move on underneath the call, which is
			// what decides whether the reason lands beside its message or wherever
			// the end happens to be by the time it arrives.
			let refuse: (reason: Error) => void = () => {};
			mockState.sendMessage.mockReturnValueOnce(
				new Promise((_resolve, reject) => {
					refuse = reject;
				}),
			);
			await user.type(screen.getByRole("textbox"), "Also look at X");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			act(() => {
				mockState.onNotification?.({
					type: "message",
					content: "sent from another tab",
				});
			});
			act(() => {
				refuse(
					new Error(
						"this turn is waiting for an answer to the request on screen",
					),
				);
			});

			const reason = "waiting for an answer to the request on screen";
			await waitFor(() => {
				expect(screen.getByText(new RegExp(reason))).toBeInTheDocument();
			});

			// Beside the message it could not deliver, not at the end of a
			// transcript that has moved on past it.
			const transcript = document.body.textContent ?? "";
			expect(transcript.indexOf("Also look at X")).toBeLessThan(
				transcript.indexOf(reason),
			);
			expect(transcript.indexOf(reason)).toBeLessThan(
				transcript.indexOf("sent from another tab"),
			);

			// The turn it failed to reach is untouched and still running.
			act(() => {
				mockState.onNotification?.({ type: "text", content: " — carrying on" });
			});
			expect(
				screen.getByText("Working on it — carrying on"),
			).toBeInTheDocument();
		});

		// The other reason a mid-turn send finds no placeholder to fail in, and the
		// one that must not be mistaken for the first: the transcript on screen is
		// no longer the one the message was sent to. Reporting into it would put a
		// failure from one conversation into another.
		it("says nothing when the session was switched under a failed send", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<ChatPanel {...defaultProps} sessionId="previous" />,
			);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			setTurn("running");
			act(() => {
				mockState.onNotification?.({ type: "text", content: "Working on it" });
			});

			let refuse: (reason: Error) => void = () => {};
			mockState.sendMessage.mockReturnValueOnce(
				new Promise((_resolve, reject) => {
					refuse = reject;
				}),
			);
			await user.type(screen.getByRole("textbox"), "Also look at X");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			rerender(<ChatPanel {...defaultProps} sessionId="destination" />);
			await waitForHistoryLoad();

			// Awaited rather than a bare `act`: the rejection is handled on a
			// microtask, so a synchronous flush would assert on a transcript the
			// failure had not reached yet and pass whatever the code did with it.
			const reason = "waiting for an answer to the request on screen";
			await act(async () => {
				refuse(new Error(reason));
			});

			expect(screen.queryByText(new RegExp(reason))).not.toBeInTheDocument();
			expect(screen.queryByText("Also look at X")).not.toBeInTheDocument();
		});

		// The reply the message went into is still being written, and the bubble
		// has to keep saying so. It stops being the last row the moment the message
		// lands under it, so anything reading position takes the spinner away
		// exactly when the user has just asked the agent something.
		it("keeps the reply spinning under the message sent into it", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			setTurn("running");
			act(() => {
				mockState.onNotification?.({ type: "text", content: "Working on it" });
			});
			// By label: the list's own scroll-position output is a `status` too.
			expect(screen.getByLabelText("Loading")).toBeInTheDocument();

			await user.type(screen.getByRole("textbox"), "Also look at X");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			await screen.findByText("Also look at X");
			expect(screen.getByLabelText("Loading")).toBeInTheDocument();

			// And it goes when the turn does, rather than spinning on.
			act(() => {
				mockState.onNotification?.({ type: "done" });
			});
			expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
		});

		// The only receipt a mid-turn send gets: nothing new appears under the
		// message, because the reply above it goes on growing.
		it("acknowledges a message that went into the running turn", async () => {
			const user = userEvent.setup();
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "Hi");
			await user.click(screen.getByRole("button", { name: /Send/ }));
			setTurn("running");
			act(() => {
				mockState.onNotification?.({ type: "text", content: "Working on it" });
			});

			await user.type(screen.getByRole("textbox"), "Also look at X");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			await waitFor(() => {
				expect(
					screen.getByText("Sent into the reply the agent is working on."),
				).toBeInTheDocument();
			});

			// The reply carries on in the bubble it was already in, above the new
			// message, and the receipt goes when the turn ends.
			act(() => {
				mockState.onNotification?.({ type: "text", content: " — and X" });
			});
			expect(screen.getByText("Working on it — and X")).toBeInTheDocument();

			act(() => {
				mockState.onNotification?.({ type: "done" });
				acceptSetting({
					turn: { phase: "idle", open: false, since: "2024-01-01T00:00:00Z" },
				});
			});
			expect(
				screen.queryByText("Sent into the reply the agent is working on."),
			).not.toBeInTheDocument();
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
			seedSessionDetail({ agent_type: "codex" });
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

		// An answer only ever reaches the process that raised the prompt, so the
		// server refuses one aimed at a process that is gone. What that refusal
		// means for the card is not the failure's to say — a dropped socket looks
		// exactly the same from here — so the session's turn decides, and it is
		// the thing that lists the prompts still waiting on someone
		// (docs/lifecycle-ui.md §8).
		describe("an answer the server refuses", () => {
			const raisePermission = () =>
				act(() => {
					mockState.onNotification?.({
						type: "permission_request",
						request_id: "req-9",
						tool_name: "Edit",
						tool_input: { file_path: "/etc/hosts" },
						tool_use_id: "tool-9",
					});
				});

			const blockedOn = (requestId: string) =>
				acceptSetting({
					turn: {
						phase: "blocked",
						open: true,
						since: "2024-01-01T00:00:00Z",
						blockers: [
							{
								kind: "permission",
								request_id: requestId,
								raised_at: "2024-01-01T00:00:00Z",
							},
						],
					},
				});

			it("leaves the card answerable when the prompt is still waiting", async () => {
				const user = userEvent.setup();
				mockState.permissionResponse.mockRejectedValueOnce(
					new Error("connection lost"),
				);
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				raisePermission();
				act(() => blockedOn("req-9"));

				await user.click(screen.getByRole("button", { name: "Allow" }));

				expect(await screen.findByRole("alert")).toHaveTextContent(
					"connection lost",
				);
				// Still pending, so the user can simply press it again.
				expect(
					screen.getByRole("button", { name: "Allow" }),
				).toBeInTheDocument();
			});

			it("retires the card once the turn no longer lists the prompt", async () => {
				const user = userEvent.setup();
				mockState.permissionResponse.mockRejectedValueOnce(
					new Error("session is no longer running"),
				);
				render(<ChatPanel {...defaultProps} />);
				await waitForHistoryLoad();
				raisePermission();
				act(() =>
					acceptSetting({
						turn: { phase: "idle", open: false, since: "2024-01-01T00:00:00Z" },
					}),
				);

				await user.click(screen.getByRole("button", { name: "Allow" }));

				// The reason survives the buttons going away: an error that
				// disappears with the control it belongs to is a silent failure.
				expect(await screen.findByRole("alert")).toHaveTextContent(
					"session is no longer running",
				);
				expect(
					screen.queryByRole("button", { name: "Allow" }),
				).not.toBeInTheDocument();
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

			// Stop follows the session's turn, not the transcript: the server
			// reporting a running turn is what puts the button on screen.
			act(() => {
				acceptSetting({
					turn: { phase: "running", open: true, since: "2024-01-01T00:00:00Z" },
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

			act(() => {
				acceptSetting({
					turn: { phase: "running", open: true, since: "2024-01-01T00:00:00Z" },
				});
			});
			mockState.interrupt.mockClear();

			// Press Escape while the turn is open
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
					overlay={{ type: "work-list", segment: "current" }}
					onCloseOverlay={vi.fn()}
				/>,
			);

			await user.keyboard("{Escape}");

			expect(mockState.interrupt).not.toHaveBeenCalled();
		});
	});

	// Transcripts written before Pockode stopped letting a CLI ask its own
	// blocking question still hold `ask_user_question` records. They render through
	// the same card a posted question gets, so an old conversation reads the way it
	// always did — but a pending one says it can no longer be answered, because the
	// process that was holding that tool call open is long gone.
	describe("a legacy CLI question in history", () => {
		const legacyQuestion = {
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
		};

		it("restores the answered form when replaying history", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = [
				legacyQuestion,
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

		// Nothing can answer it, so the card says so rather than offering a way in
		// to a panel the question is not in.
		it("says an unanswered one can no longer be answered", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = [legacyQuestion, { type: "done" }];

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			expect(screen.getByText("Pending")).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: /Library/ }));

			expect(screen.getByText(/can no longer be answered/)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Answer this" })).toBeNull();
		});

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
		const seedSession = (activated: boolean, model = "", effort = "") =>
			seedSessionDetail({ model, effort, activated });

		const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
			await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		};

		// Both lists name their empty value "Auto"; the legend above each is what
		// tells them apart, for a screen reader as much as for this test.
		const section = (title: string) =>
			within(screen.getByRole("group", { name: title }));

		// The chip is built entirely from the session's own settings — agent
		// included — and a session that has not described itself yet has none.
		// Naming a placeholder would describe the session wrongly and then correct
		// itself a round trip later.
		it("names nothing until the session's own snapshot arrives", async () => {
			useSessionDetailStore.getState().clear();

			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			// Not "Engine: Claude, loading": the agent is a setting too, and Claude
			// is only the placeholder the session would be misdescribed by.
			expect(
				screen.getByRole("button", { name: "Engine: loading" }),
			).toBeDisabled();
			// Same for the mode, and here the placeholder is the calm one: a YOLO
			// session would wear Default's shield until the snapshot landed. The
			// button is also disabled, because picking the shown mode back would be
			// taken for "no change" and swallowed.
			expect(
				screen.getByRole("button", { name: "Mode: loading" }),
			).toBeDisabled();
		});

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

	// The panel reads the session's usage off the same detail subscription every
	// other setting comes from, which is what makes the figures live.
	describe("session info", () => {
		it("shows what the session has spent, and keeps up as it spends more", async () => {
			const user = userEvent.setup();
			seedSessionDetail({
				usage: {
					input_tokens: 800,
					output_tokens: 200,
					cache_read_tokens: 0,
					cache_write_tokens: 0,
				},
			});
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			await user.click(screen.getByRole("button", { name: "Session info" }));
			expect(await screen.findByText("1,000")).toBeInTheDocument();

			act(() => {
				acceptSetting({
					usage: {
						input_tokens: 1200,
						output_tokens: 300,
						cache_read_tokens: 0,
						cache_write_tokens: 0,
					},
				});
			});

			expect(await screen.findByText("1,500")).toBeInTheDocument();
		});
	});

	// A work's life and its chat process are two separate clocks, and the chat
	// now reads neither off the other: an interrupt stops the work without
	// emitting any message, so anything in the transcript claiming to know the
	// work's state would be lying exactly when the user most needs the truth.
	describe("when a work and its chat process end at different times", () => {
		const emit = (...notifications: ServerNotification[]) => {
			act(() => {
				for (const n of notifications) mockState.onNotification?.(n);
			});
		};

		const autoContinue: ServerNotification = {
			type: "message",
			content: "Your last turn ended without moving this task along.",
			origin: "system",
			subtype: "auto_continue",
			meta: {
				work_id: "work-1",
				work_type: "task",
				title: "Ship the status bar",
				step: { current: 2, total: 3 },
			},
		};

		// The only way into the work from the chat now that the top bar is gone,
		// so the whole path from the event line to the host has to hold.
		it("opens the work detail from the event it happened to", async () => {
			const user = userEvent.setup();
			const onOpenWorkDetail = vi.fn();
			seedWork({ status: "active" }, ["a", "b", "c"]);
			render(
				<ChatPanel {...defaultProps} onOpenWorkDetail={onOpenWorkDetail} />,
			);
			await waitForHistoryLoad();

			emit(autoContinue);

			await user.click(screen.getByText("Pockode · Continued"));
			await user.click(screen.getByRole("button", { name: "Details" }));

			expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
		});

		it("leaves the work's status out of the chat entirely", async () => {
			seedWork({ status: "active" }, ["a", "b", "c"]);
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			emit(autoContinue);
			// The user interrupts before the agent writes a word.
			emit({ type: "interrupted" });

			// The turn speaks only for the agent's output.
			expect(screen.getByText("Interrupted")).toBeInTheDocument();
			// The event says what happened, in the past tense, and stops there.
			expect(screen.getByText("Pockode · Continued")).toBeInTheDocument();
			expect(
				screen.queryByRole("status", { name: "Loading" }),
			).not.toBeInTheDocument();

			// The work stopping changes nothing on screen: no element was reporting
			// its status to begin with.
			setWorkStatus("stopped");

			expect(screen.getByText("Pockode · Continued")).toBeInTheDocument();
			expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Restart" }),
			).not.toBeInTheDocument();
			expect(screen.getByText("Interrupted")).toBeInTheDocument();
		});

		it("lets the chat keep streaming after the work has closed", async () => {
			seedWork({ status: "active" }, ["a", "b", "c"]);
			render(<ChatPanel {...defaultProps} />);
			await waitForHistoryLoad();

			emit(autoContinue, { type: "text", content: "wrapping up" });

			setWorkStatus("closed");

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
	describe("forking a session", () => {
		const forkHistory = [
			{ type: "message", content: "Hello", seq: 1 },
			{ type: "text", content: "Hi there!", seq: 2 },
			{ type: "done", seq: 3 },
			{ type: "message", content: "Try again", seq: 4 },
			{ type: "text", content: "Second answer", seq: 5 },
			{ type: "done", seq: 6 },
		];

		const forkedSession = makeSessionListItem({
			id: "forked-session",
			title: "Test Chat (fork)",
			forked_from: { session_id: "test-session" },
		});

		/** Opens the menu beside the nth bubble of one speaker; -1 is the last. */
		const openMenu = async (
			user: ReturnType<typeof userEvent.setup>,
			side: "user" | "assistant",
			index = 0,
		) => {
			const triggers = await screen.findAllByRole("button", {
				name:
					side === "user"
						? "Actions for your message"
						: "Actions for the agent's message",
			});
			await user.click(triggers[index < 0 ? triggers.length + index : index]);
		};

		// Two steps now that the action lives in a menu: open the `…` beside the
		// first assistant answer, then take the fork row. That answer is the first
		// offer in the transcript — the opening prompt above it has nothing behind
		// it to fork to.
		const openForkSheet = async (user: ReturnType<typeof userEvent.setup>) => {
			await openMenu(user, "assistant");
			await user.click(screen.getByRole("button", { name: /Fork from here/ }));
		};

		// An agent that was never forkable has no refusal to explain, so it gets
		// neither the `…` nor the slot the `…` would have sat in — a session that
		// can do nothing to its messages should not pay for the room. Driven by
		// the server's declaration, not by which agent the session runs.
		it("reserves nothing at all when the agent cannot be forked", async () => {
			mockState.mockHistory = forkHistory;
			mockState.listAgents.mockResolvedValueOnce([
				{ type: "claude", fork_support: "none" },
			]);

			// The trigger exists only where forking can navigate to the result.
			const { container } = render(
				<ChatPanel {...defaultProps} onSelectSession={vi.fn()} />,
			);
			await waitForHistoryLoad();

			// Waited for, not asserted once: the declaration arrives after the
			// first paint, and `null` until then means "offer it" (useForkSupport).
			await waitFor(() =>
				expect(
					screen.queryAllByRole("button", { name: /^Actions for/ }),
				).toHaveLength(0),
			);
			// The transcript really is on screen, so the absence below is the
			// declaration talking and not a render that never happened.
			expect(screen.getByText("Hi there!")).toBeInTheDocument();
			// Scoped to the transcript rows, and matched by size, not by alignment:
			// over the whole panel this would also count the composer's own 36px
			// buttons and could never reach 0, while naming the alignment would
			// leave the selector empty — and this assertion silently passing — the
			// next time the alignment changes.
			const rows = container.querySelectorAll("[data-message-id]");
			expect(rows).not.toHaveLength(0);
			for (const row of rows) {
				expect(row.querySelectorAll("div.size-9")).toHaveLength(0);
			}
		});

		it("forks from the chosen message and opens the new session", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = forkHistory;
			mockState.forkSession.mockResolvedValue(forkedSession);
			const onSelectSession = vi.fn();

			render(<ChatPanel {...defaultProps} onSelectSession={onSelectSession} />);
			await waitForHistoryLoad();

			await openForkSheet(user);

			// The anchor is echoed back, and so is what forking there costs.
			const sheet = within(screen.getByRole("dialog"));
			expect(sheet.getByText("Hi there!")).toBeInTheDocument();
			expect(
				sheet.getByText(/The 2 messages after it stay in this session/),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Fork" }));

			await waitFor(() =>
				expect(onSelectSession).toHaveBeenCalledWith("forked-session"),
			);
			// Seq 3, the last record folded into that answer — never a count of the
			// messages above it.
			expect(mockState.forkSession).toHaveBeenCalledWith(
				"test-session",
				3,
				"Test Chat (fork)",
			);
			// Findable straight away, rather than only once the subscription
			// catches up.
			expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain(
				"forked-session",
			);
			// An agent anchor is kept by the fork, so there is nothing to restore
			// and the new session opens on an empty input box.
			expect(useInputStore.getState().inputs["forked-session"]).toBeUndefined();
		});

		// Landing the user in a session that may not exist is worse than the error.
		it("keeps the sheet open and never navigates when the fork fails", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = forkHistory;
			mockState.forkSession.mockRejectedValue(new Error("session not found"));
			const onSelectSession = vi.fn();

			render(<ChatPanel {...defaultProps} onSelectSession={onSelectSession} />);
			await waitForHistoryLoad();

			await openForkSheet(user);
			await user.click(screen.getByRole("button", { name: "Fork" }));

			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					"session not found",
				),
			);
			expect(onSelectSession).not.toHaveBeenCalled();
			// Retrying is pressing Fork again.
			expect(screen.getByRole("button", { name: "Fork" })).toBeEnabled();
		});

		// The live path and the replay path have to agree: a seq that only
		// survived one of them would fork from a different place depending on
		// whether the user had reloaded.
		it("anchors on a seq that arrived live, not only on replayed history", async () => {
			const user = userEvent.setup();
			mockState.forkSession.mockResolvedValue(forkedSession);
			const onSelectSession = vi.fn();

			render(<ChatPanel {...defaultProps} onSelectSession={onSelectSession} />);
			await waitForHistoryLoad();

			act(() => {
				mockState.onNotification?.({
					type: "message",
					content: "Hello",
					seq: 7,
				} as ServerNotification);
				mockState.onNotification?.({
					type: "text",
					content: "Hi there!",
					seq: 8,
				} as ServerNotification);
				mockState.onNotification?.({
					type: "done",
					seq: 9,
				} as ServerNotification);
			});

			await openForkSheet(user);
			await user.click(screen.getByRole("button", { name: "Fork" }));

			await waitFor(() =>
				expect(mockState.forkSession).toHaveBeenCalledWith(
					"test-session",
					9,
					"Test Chat (fork)",
				),
			);
		});

		// The seq arrives a moment later, so the row stays where it was and says
		// why instead of vanishing. `aria-disabled`, not the native attribute:
		// the reason is worth nothing if focus cannot reach it.
		it("disables fork on a message that has no settled cut point", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = [
				{ type: "message", content: "Opening", seq: 1 },
				{ type: "text", content: "Sure", seq: 2 },
				{ type: "done", seq: 3 },
				// No seq: a record the server could not persist, or one this tab sent
				// to a server too old to answer with its address. Nothing the client
				// can name.
				{ type: "message", content: "Hello" },
			];

			render(<ChatPanel {...defaultProps} onSelectSession={vi.fn()} />);
			await waitForHistoryLoad();

			// "Hello", the message with no seq — the one above it opens the session
			// and is refused for its own reason.
			await openMenu(user, "user", 1);
			const fork = screen.getByRole("button", { name: /Fork from here/ });
			expect(fork).toHaveAttribute("aria-disabled", "true");
			// Written out where a finger can read it: a tooltip never fires on a
			// touch screen, so a reason living only in a label is out of reach.
			expect(fork).toHaveTextContent(
				"This message has no saved position to fork from.",
			);
			// Nothing the user can do about it, and one flavour of it no reload
			// brings back, so the sentence neither directs nor promises.
			expect(fork).not.toHaveTextContent("yet");
			fork.focus();
			expect(fork).toHaveFocus();

			await user.click(fork);
			// The menu is still the only dialog: nothing replaced it.
			expect(screen.getByRole("dialog")).toHaveAccessibleName("Your message");
			expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
		});

		// A fork anchored on something the user said returns to before they said
		// it, so the session's opening prompt has nothing behind it to keep —
		// permanently, which is why this label does not say "yet".
		it("disables fork on the message that opens the session", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = forkHistory;

			render(<ChatPanel {...defaultProps} onSelectSession={vi.fn()} />);
			await waitForHistoryLoad();

			await openMenu(user, "user", 0);
			const fork = screen.getByRole("button", { name: /Fork from here/ });
			expect(fork).toHaveAttribute("aria-disabled", "true");
			expect(fork).toHaveTextContent("Nothing before this message to keep.");
			// Permanent, so the sentence must not promise a later.
			expect(fork).not.toHaveTextContent("yet");

			await user.click(fork);
			expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
		});

		// The two features meet here: history pages in from the bottom, so the
		// message at the top of what is loaded is the session's opening prompt
		// only once there is nothing older left to read.
		it("keeps fork on the top message while older pages remain", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = forkHistory;
			mockState.chatMessagesSubscribe.mockImplementation(() =>
				Promise.resolve({
					id: "sub-1",
					initial: {
						history: mockState.mockHistory,
						turn: { phase: "idle", open: false, since: "" },
						next_before_seq: 1,
					},
				}),
			);
			mockState.forkSession.mockResolvedValue(forkedSession);

			render(<ChatPanel {...defaultProps} onSelectSession={vi.fn()} />);
			await waitForHistoryLoad();

			await openMenu(user, "user", 0);
			const fork = screen.getByRole("button", { name: /Fork from here/ });
			expect(fork).not.toHaveAttribute("aria-disabled");
			expect(fork).not.toHaveTextContent("Nothing before this message");

			await user.click(fork);
			expect(
				await screen.findByRole("button", { name: "Fork" }),
			).toBeInTheDocument();
		});

		// The message you just sent is the one you most want to fork from — you
		// asked, the answer disappointed, and you want to rephrase. It used to be
		// the one message that could not be forked from at all until the session
		// was reloaded: the sender is left out of the broadcast carrying every
		// other record's seq. Now the send's own reply brings it.
		it("forks from a message this tab just sent, with no reload", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = forkHistory;
			mockState.sendMessage.mockResolvedValue(7);
			mockState.forkSession.mockResolvedValue(forkedSession);

			render(<ChatPanel {...defaultProps} onSelectSession={vi.fn()} />);
			await waitForHistoryLoad();

			await user.type(screen.getByRole("textbox"), "One more thing");
			await user.click(screen.getByRole("button", { name: /Send/ }));

			// Nothing was resubscribed and no history was replayed: the only place
			// this seq can have come from is the reply to the send itself.
			expect(mockState.chatMessagesSubscribe).toHaveBeenCalledTimes(1);
			await openMenu(user, "user", -1);
			const fork = screen.getByRole("button", { name: /Fork from here/ });
			expect(fork).not.toHaveAttribute("aria-disabled");

			await user.click(fork);
			const sheet = within(screen.getByRole("dialog"));
			expect(sheet.getByText("One more thing")).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Fork" }));

			await waitFor(() =>
				expect(mockState.forkSession).toHaveBeenCalledWith(
					"test-session",
					7,
					"Test Chat (fork)",
				),
			);
		});

		// The seq goes back untouched and the sheet says the anchor is left
		// behind: the "before this message" rule is the server's, and the client
		// neither shifts the address nor claims to keep the prompt.
		it("forks from a user message back to just before it", async () => {
			const user = userEvent.setup();
			mockState.mockHistory = forkHistory;
			mockState.forkSession.mockResolvedValue(forkedSession);

			render(<ChatPanel {...defaultProps} onSelectSession={vi.fn()} />);
			await waitForHistoryLoad();

			// "Try again", the second thing the user said.
			await openMenu(user, "user", 1);
			await user.click(screen.getByRole("button", { name: /Fork from here/ }));

			const sheet = within(screen.getByRole("dialog"));
			expect(sheet.getByText("Try again")).toBeInTheDocument();
			expect(
				sheet.getByText(
					/up to just before this message\. This message and the one after it stay in this session/,
				),
			).toBeInTheDocument();

			await user.click(screen.getByRole("button", { name: "Fork" }));

			await waitFor(() =>
				expect(mockState.forkSession).toHaveBeenCalledWith(
					"test-session",
					4,
					"Test Chat (fork)",
				),
			);
			// The prompt the fork dropped waits in the new session's input box, to
			// re-send or edit. A draft, not a message: nothing was sent.
			expect(useInputStore.getState().inputs["forked-session"]).toBe(
				"Try again",
			);
			expect(mockState.sendMessage).not.toHaveBeenCalled();
		});

		it("says at the top of the transcript where the session came from", async () => {
			const user = userEvent.setup();
			const onSelectSession = vi.fn();
			seedSessionDetail({ forked_from: { session_id: "parent-session" } });
			// The parent's title is still resolved from the list: that one is a fact
			// about another session, which this session's detail cannot report.
			useSessionStore.setState({
				sessions: [
					{ ...forkedSession, id: "parent-session", title: "Parent chat" },
				],
			});
			mockState.mockHistory = forkHistory;

			render(<ChatPanel {...defaultProps} onSelectSession={onSelectSession} />);
			await waitForHistoryLoad();

			const banner = screen.getByRole("button", {
				name: /Forked from "Parent chat"/,
			});
			await user.click(banner);
			expect(onSelectSession).toHaveBeenCalledWith("parent-session");
		});
	});
	// A session whose data is read out of another worktree. Everything about the
	// screen that says "you cannot write here" is decided by the `view` prop
	// alone; the server refuses a write either way, so this is presentation.
	describe("when the session is read out of another worktree", () => {
		const deleted = { worktree: "old-fix", exists: false, label: "old-fix" };
		const elsewhere = {
			worktree: "feature-x",
			exists: true,
			label: "feature-x",
		};

		it("reads the transcript through session_view, not the chat subscription", async () => {
			mockState.sessionViewHistory.mockResolvedValue({
				history: [{ type: "message", content: "What did we decide?", seq: 1 }],
				has_more: false,
			});

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);

			expect(
				await screen.findByText("What did we decide?"),
			).toBeInTheDocument();
			expect(mockState.sessionViewHistory).toHaveBeenCalledWith(
				"old-fix",
				"test-session",
			);
			// Subscribing would ask the bound worktree about a session it has never
			// heard of — and would promise updates that cannot come.
			expect(mockState.chatMessagesSubscribe).not.toHaveBeenCalled();
		});

		it("replaces the composer with a statement of why there is none", async () => {
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);
			await waitForHistoryLoad();

			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /Send/ }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText(/the worktree "old-fix" no longer exists/i),
			).toBeInTheDocument();
		});

		it("says whose session it is, above the transcript", async () => {
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);
			await waitForHistoryLoad();

			expect(
				screen.getByText(/Session from "old-fix" \(deleted\)/),
			).toBeInTheDocument();
		});

		it("offers the way back into a worktree that still exists", async () => {
			const user = userEvent.setup();
			const onOpenSessionThere = vi.fn();
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={elsewhere}
					onOpenSessionThere={onOpenSessionThere}
				/>,
			);
			await waitForHistoryLoad();

			await user.click(
				screen.getByRole("button", {
					name: "Open this session in worktree feature-x",
				}),
			);
			expect(onOpenSessionThere).toHaveBeenCalled();
		});

		it("offers no way back into a worktree that is gone", async () => {
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
					onOpenSessionThere={vi.fn()}
				/>,
			);
			await waitForHistoryLoad();

			expect(
				screen.queryByRole("button", { name: /Open this session/ }),
			).not.toBeInTheDocument();
		});

		it("drops the controls that would change the session, keeping Session info", async () => {
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);
			await waitForHistoryLoad();

			// Removed rather than disabled: there is no execution environment to
			// come back.
			expect(
				screen.queryByRole("button", { name: /Agent:/ }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /Mode:/ }),
			).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Session info" }),
			).toBeInTheDocument();
		});

		// The openers a transcript carries for answering back, none of which has
		// a process to reach. A permission card is already settled by the idle
		// turn a viewed transcript is read under; the question card is not — its
		// status comes from the records themselves — so "Answer this" survived
		// into a screen whose answer panel is not even rendered.
		it("offers nothing to answer a question the transcript left pending", async () => {
			mockState.sessionViewHistory.mockResolvedValue({
				history: [
					{
						type: "question_posted",
						request_id: "req-1",
						questions: [{ header: "Which branch?", question: "Which branch?" }],
						seq: 1,
					},
				],
				has_more: false,
			});
			const user = userEvent.setup();

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);

			// The card is still there and still says the question went unanswered;
			// what is gone is the control that claims it can be answered now.
			const card = await screen.findByRole("button", { name: /Question/ });
			await user.click(card);
			expect(
				screen.queryByRole("button", { name: "Answer this" }),
			).not.toBeInTheDocument();
		});

		it("offers no Allow or Deny on a permission the transcript left pending", async () => {
			mockState.sessionViewHistory.mockResolvedValue({
				history: [
					{
						type: "permission_request",
						request_id: "req-1",
						tool_name: "Bash",
						tool_input: { command: "rm -rf /" },
						tool_use_id: "tool-1",
						seq: 1,
					},
				],
				has_more: false,
			});

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);

			expect(await screen.findByText("Bash")).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Allow" }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Deny" }),
			).not.toBeInTheDocument();
		});

		// The bar below has just said this conversation cannot be added to.
		it("does not invite a conversation it has no composer for", async () => {
			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);
			await waitForHistoryLoad();

			expect(
				screen.getByText("Nothing was said in this conversation."),
			).toBeInTheDocument();
			expect(
				screen.queryByText("Start a conversation..."),
			).not.toBeInTheDocument();
		});

		// A work's chat link is the usual way onto this screen, so the row back to
		// that work is the one thing Session info is kept open for here. It comes
		// off the viewed session's own detail — the detail store holds the bound
		// worktree's session and has no entry for this one.
		it("keeps the way back to the work the viewed session runs", async () => {
			const user = userEvent.setup();
			const onOpenWorkDetail = vi.fn();
			mockState.sessionViewGet.mockResolvedValue(
				makeSessionDetail({
					id: "test-session",
					title: "Old Chat",
					work_id: "work-1",
				}),
			);

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
					onOpenWorkDetail={onOpenWorkDetail}
				/>,
			);
			await waitForHistoryLoad();

			await user.click(screen.getByRole("button", { name: "Session info" }));
			await user.click(screen.getByRole("button", { name: "Old Chat" }));

			expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
		});

		it("says so when the session is not there, rather than showing nothing", async () => {
			mockState.isInvalidParamsRejection.mockReturnValue(true);
			mockState.sessionViewGet.mockRejectedValue(
				new Error("session not found"),
			);
			mockState.sessionViewHistory.mockRejectedValue(
				new Error("session not found"),
			);

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);

			// An empty transcript would read as "they never said anything".
			expect(await screen.findByRole("alert")).toHaveTextContent(
				'This session is not in "old-fix" any more.',
			);
		});

		// The two reads answer one question — can this conversation be read — so a
		// transcript that failed while the metadata arrived must not come out as a
		// conversation in which nobody said anything.
		it("says so when the transcript alone could not be read", async () => {
			mockState.sessionViewHistory.mockRejectedValue(
				new Error("failed to read session history"),
			);

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"failed to read session history",
			);
		});

		it("takes its title from its own metadata, there being no row for it", async () => {
			mockState.isInvalidParamsRejection.mockReturnValue(false);
			mockState.sessionViewGet.mockResolvedValue(
				makeSessionDetail({ id: "test-session", title: "Old Chat" }),
			);

			render(
				<ChatPanel
					{...defaultProps}
					sessionTitle=""
					isSessionResolved={false}
					view={deleted}
				/>,
			);
			await waitForHistoryLoad();

			await waitFor(() =>
				expect(mockState.sessionViewGet).toHaveBeenCalledWith(
					"old-fix",
					"test-session",
				),
			);
		});
	});
});
