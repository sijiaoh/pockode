import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import { makeSessionDetail } from "../test/sessionFixtures";
import type {
	AssistantMessage,
	Message,
	ServerNotification,
	SessionDetail,
	UserMessage,
} from "../types/message";
import { isForkableMessage } from "../utils/forkAnchor";
import { useChatMessages } from "./useChatMessages";

const mockState = vi.hoisted(() => ({
	/** Drives a reconnect: see `reconnect` below. */
	status: "connected",
	chatMessagesSubscribe: vi.fn(),
	chatMessagesHistory: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(async () => {}),
	// Mirrors ChatActions.sendMessage: it resolves with the seq the server gave
	// the message, or undefined when there is no address to give.
	sendMessage: vi.fn(
		(): Promise<number | undefined> => Promise.resolve(undefined),
	),
}));

vi.mock("../lib/wsStore", () => {
	const state = {
		get status() {
			return mockState.status;
		},
		actions: {
			chatMessagesSubscribe: mockState.chatMessagesSubscribe,
			chatMessagesHistory: mockState.chatMessagesHistory,
			chatMessagesUnsubscribe: mockState.chatMessagesUnsubscribe,
			sendMessage: mockState.sendMessage,
		},
	};
	const store = ((selector: (s: unknown) => unknown) =>
		selector(state)) as unknown as {
		(selector: (s: unknown) => unknown): unknown;
		getState: () => typeof state;
	};
	store.getState = () => state;
	return { useWSStore: store };
});

function setDetailTurn(sessionId: string, turn: SessionDetail["turn"]) {
	useSessionDetailStore
		.getState()
		.setDetail(sessionId, makeSessionDetail({ id: sessionId, turn }));
}

const history = (text: string): ServerNotification[] => [
	{ type: "text", content: text } as ServerNotification,
];

// Records every *committed* state, so a session id paired with the previous
// session's messages is caught even though the pairing lasts a single frame.
// Recording during render instead would also capture renders React discards
// without ever putting them on screen, which is precisely what the fix relies
// on.
const committed: { sessionId: string; messageCount: number }[] = [];

function Probe({ sessionId }: { sessionId: string }) {
	const { messages } = useChatMessages({ sessionId });
	useLayoutEffect(() => {
		committed.push({ sessionId, messageCount: messages.length });
	});
	return null;
}

function renderSendProbe() {
	const latest: { messages: Message[] } = { messages: [] };
	const send = { current: async (_content: string) => false };
	function SendProbe() {
		const { messages, sendUserMessage } = useChatMessages({ sessionId: "s1" });
		latest.messages = messages;
		send.current = sendUserMessage;
		return null;
	}
	render(<SendProbe />);
	return { latest, send };
}

function findSent(messages: Message[]): UserMessage {
	const sent = messages.find(
		(m) => m.role === "user" && m.content === "Try again",
	);
	if (sent?.role !== "user") {
		throw new Error("the message just sent is not in the transcript");
	}
	return sent;
}

describe("useChatMessages", () => {
	beforeEach(() => {
		committed.length = 0;
		mockState.status = "connected";
		mockState.sendMessage.mockReset();
		mockState.sendMessage.mockResolvedValue(undefined);
		mockState.chatMessagesHistory.mockReset();
		useSessionDetailStore.getState().clear();
		mockState.chatMessagesSubscribe.mockImplementation(
			async (sessionId: string) => ({
				id: `sub-${sessionId}`,
				initial: {
					history: history(`message of ${sessionId}`),
					turn: { phase: "idle", open: false, since: "" },
				},
			}),
		);
	});

	// The whole point of the switch work: at no instant may the previous
	// session's transcript be on screen under the new session's identity. The
	// reset has to happen while rendering — an effect would run only after that
	// pairing had already been committed to the DOM.
	it("never pairs a new session id with the previous session's messages", async () => {
		const { rerender } = render(<Probe sessionId="previous" />);
		await waitFor(() => {
			expect(committed.at(-1)?.messageCount).toBeGreaterThan(0);
		});

		rerender(<Probe sessionId="destination" />);

		// The first frame carrying the new id is the one at risk: an effect-based
		// reset lets it reach the DOM with the previous transcript still in it.
		expect(committed.find((r) => r.sessionId === "destination")).toEqual({
			sessionId: "destination",
			messageCount: 0,
		});

		// And the destination still loads its own history afterwards.
		await waitFor(() => {
			expect(committed.at(-1)?.messageCount).toBeGreaterThan(0);
		});
	});

	// Sending locally is its own entry point — it appends straight to the list
	// rather than going through applyServerEvent — so the rule that an unanswered
	// placeholder is not left behind has to hold here too, or the plain user path
	// would keep the blank bubbles the system-message path no longer has.
	it("leaves no blank bubble behind when the previous turn was never answered", async () => {
		// A session whose process died right after the message was persisted: the
		// transcript ends on a placeholder the agent never wrote into.
		mockState.chatMessagesSubscribe.mockImplementation(async () => ({
			id: "sub-1",
			initial: {
				history: [{ type: "message", content: "Anyone there?" }],
				turn: { phase: "idle", open: false, since: "" },
			},
		}));

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages).toHaveLength(2));

		await act(async () => {
			await send.current("Still there?");
		});

		expect(latest.messages.map((m) => m.role)).toEqual([
			"user",
			"user",
			"assistant",
		]);
		expect((latest.messages.at(-1) as AssistantMessage).status).toBe("sending");
	});

	// The message a client sends itself is the one it is never told the seq of:
	// the broadcast that carries every other record's address deliberately skips
	// the sender. Without the seq from the reply, forking from your own prompt —
	// the whole point of the action, right when the answer disappoints — stays
	// greyed out until the session is reloaded.
	it("can fork from a message it just sent, without a reload", async () => {
		mockState.sendMessage.mockResolvedValue(4);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		await act(async () => {
			await send.current("Try again");
		});

		const sent = findSent(latest.messages);
		expect(sent.anchorSeq).toBe(4);
		expect(isForkableMessage(sent)).toBe(true);
	});

	// Purely additive on the wire: a server that predates the seq answers with an
	// empty result. The message simply stays unaddressable, as every locally sent
	// one used to be — it must not fail the send or blank the fork icon's row.
	it("sends normally against a server that replies with no seq", async () => {
		mockState.sendMessage.mockResolvedValue(undefined);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		let ok = false;
		await act(async () => {
			ok = await send.current("Try again");
		});

		expect(ok).toBe(true);
		const sent = findSent(latest.messages);
		expect(sent.anchorSeq).toBeUndefined();
		expect(isForkableMessage(sent)).toBe(false);
	});

	// A Task subagent keeps talking for a moment after the user stops the turn.
	// `turnOpen` is what blocks the composer and shows the Stop button, and it
	// reads the session's turn rather than the last bubble's status — so a late
	// message cannot revive it, and a stopped session cannot look like a running
	// one. The old bookkeeping inferred liveness from the transcript, which is
	// exactly what this case broke.
	it("follows the session's turn, not the last message", async () => {
		let notify: ((notification: ServerNotification) => void) | undefined;
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ServerNotification) => void,
			) => {
				notify = onNotification;
				return {
					id: "sub-1",
					initial: {
						history: [
							{ type: "message", content: "Do the thing" },
							{ type: "text", content: "Working" },
						],
						turn: { phase: "running", open: true, since: "" },
					},
				};
			},
		);

		let open = false;
		function StreamProbe() {
			const { turnOpen } = useChatMessages({ sessionId: "s1" });
			open = turnOpen;
			return null;
		}

		setDetailTurn("s1", { phase: "running", open: true, since: "" });
		render(<StreamProbe />);
		await waitFor(() => expect(open).toBe(true));

		// The turn ends where it really ends: in the session's state.
		act(() => setDetailTurn("s1", { phase: "idle", open: false, since: "" }));
		expect(open).toBe(false);

		act(() =>
			notify?.({
				type: "text",
				content: "Task finished",
			} as ServerNotification),
		);
		expect(open).toBe(false);
	});

	// The window this subscription cannot afford to have: the server registers
	// the subscription before it reads the history, and writes the reply and any
	// notification from different goroutines. A record written in between is not
	// in the history that comes back and can arrive before it — applied straight
	// away it would be wiped out by the older snapshot landing after it, and the
	// message would be gone from the transcript with nothing left to say so.
	it("keeps a message that arrives before the history does", async () => {
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ServerNotification) => void,
			) => {
				onNotification({ type: "text", content: "written meanwhile" });
				return {
					id: "sub-1",
					initial: {
						history: [{ type: "message", content: "Do the thing" }],
						turn: { phase: "running", open: true, since: "" },
					},
				};
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);

		await waitFor(() => expect(messages.length).toBeGreaterThan(1));
		expect(messages[0]).toMatchObject({
			role: "user",
			content: "Do the thing",
		});
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			parts: [{ type: "text", content: "written meanwhile" }],
		});
	});

	// A phone reconnects mid-run as a matter of course, and `tool_activity` is
	// never recorded — so what a background call that started half an hour ago is
	// doing reaches a fresh subscription only in the reply.
	it("picks up what a call still in flight last reported", async () => {
		mockState.chatMessagesSubscribe.mockImplementation(async () => ({
			id: "sub-1",
			initial: {
				history: [
					{ type: "message", content: "Build it" },
					{
						type: "tool_call",
						tool_name: "Bash",
						tool_input: { command: "npm run build" },
						tool_use_id: "t1",
					},
					{
						type: "tool_result",
						tool_use_id: "t1",
						tool_result: "Command running in background with ID: bash_1",
						subtype: "background_started",
					},
				],
				turn: { phase: "running", open: true, since: "" },
				tool_activity: { t1: "Compiling 120 modules" },
			},
		}));

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);

		await waitFor(() => expect(messages.length).toBeGreaterThan(1));
		const turn = messages.at(-1) as AssistantMessage;
		expect(turn.parts[0]).toMatchObject({
			type: "tool_call",
			tool: { status: "background", activity: "Compiling 120 modules" },
		});
	});

	// Progress can arrive faster than the screen refreshes, so it is held for
	// one frame — and what the frame applies has to be all of it, in order.
	it("applies progress that arrived within one frame in order", async () => {
		let notify: (notification: ServerNotification) => void = () => {};
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ServerNotification) => void,
			) => {
				notify = onNotification;
				return {
					id: "sub-1",
					initial: {
						history: [
							{ type: "message", content: "Build it" },
							{
								type: "tool_call",
								tool_name: "Bash",
								tool_input: { command: "npm run build" },
								tool_use_id: "t1",
							},
						],
						turn: { phase: "running", open: true, since: "" },
					},
				};
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);
		await waitFor(() => expect(messages.length).toBeGreaterThan(1));

		act(() => {
			notify({
				type: "tool_activity",
				tool_use_id: "t1",
				output_delta: "one\n",
				activity: "Compiling",
			});
			notify({
				type: "tool_activity",
				tool_use_id: "t1",
				output_delta: "two\n",
				activity: "Bundling",
			});
		});

		await waitFor(() => {
			const turn = messages.at(-1) as AssistantMessage;
			// The deltas accumulate and the status is a latest value, which is
			// what lets the frame hold them merged instead of queued.
			expect(turn.parts[0]).toMatchObject({
				type: "tool_call",
				tool: { output: "one\ntwo\n", activity: "Bundling" },
			});
		});
	});

	// The same window seen from the other side: a record committed between the
	// subscription being registered and the history being read comes back in the
	// page *and* as a notification. Applied twice it would put a second copy of
	// the message in the transcript, which is what a seq is for — the live record
	// and the replayed one carry the same one.
	it("does not apply a record the history page already carried", async () => {
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ServerNotification) => void,
			) => {
				onNotification({
					type: "message",
					content: "Do the thing",
					seq: 5,
				} as unknown as ServerNotification);
				onNotification({
					type: "text",
					content: "written meanwhile",
					seq: 6,
				} as unknown as ServerNotification);
				return {
					id: "sub-1",
					initial: {
						history: [{ type: "message", content: "Do the thing", seq: 5 }],
						turn: { phase: "running", open: true, since: "" },
					},
				};
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);

		await waitFor(() => expect(messages.length).toBeGreaterThan(1));
		// The user message once, and the record the page did not reach.
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: "Do the thing",
		});
		expect(messages[1]).toMatchObject({
			role: "assistant",
			parts: [{ type: "text", content: "written meanwhile" }],
		});
	});

	describe("paging back through history", () => {
		// Renders the hook and hands the test everything it needs to page.
		function renderPager() {
			const state: {
				messages: Message[];
				hasMoreHistory: boolean;
				isLoadingMore: boolean;
				historyError: string | null;
				loadMore: () => Promise<void>;
				/** Drops the connection and brings it back, as a phone does. */
				reconnect: () => Promise<void>;
			} = {
				messages: [],
				hasMoreHistory: false,
				isLoadingMore: false,
				historyError: null,
				loadMore: async () => {},
				reconnect: async () => {},
			};
			function PageProbe() {
				const chat = useChatMessages({ sessionId: "s1" });
				state.messages = chat.messages;
				state.hasMoreHistory = chat.hasMoreHistory;
				state.isLoadingMore = chat.isLoadingMoreHistory;
				state.historyError = chat.historyError;
				state.loadMore = chat.loadMoreHistory;
				return null;
			}
			const { rerender } = render(<PageProbe />);
			// The mocked store hands out whatever `status` says at read time and
			// notifies nobody, so the re-render that lets the subscription see the
			// change has to be asked for.
			state.reconnect = async () => {
				for (const status of ["reconnecting", "connected"]) {
					mockState.status = status;
					await act(async () => {
						rerender(<PageProbe />);
					});
				}
			};
			return state;
		}

		function subscribeWith(
			history: unknown[],
			rest: Record<string, unknown> = {},
		) {
			mockState.chatMessagesSubscribe.mockImplementation(async () => ({
				id: "sub-1",
				initial: {
					history,
					has_more: true,
					next_before_seq: 7,
					turn: { phase: "idle", open: false, since: "" },
					...rest,
				},
			}));
		}

		// A phone reconnects mid-page as a matter of course, and the request it
		// interrupts learns it no longer speaks for this transcript and so skips
		// its own clean-up. Whatever the reconnect does not reset stays set for
		// good: the spinner would spin forever, and the transcript — which refuses
		// to ask while a page is on its way — would never page again.
		it("leaves paging usable when a reconnect interrupts a page in flight", async () => {
			subscribeWith([{ type: "text", content: "tail" }]);
			// The page the reconnect discards: it answers only after the fact.
			let deliver: (page: unknown) => void = () => {};
			mockState.chatMessagesHistory.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						deliver = resolve;
					}),
			);

			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			act(() => {
				state.loadMore();
			});
			await waitFor(() => expect(state.isLoadingMore).toBe(true));

			await state.reconnect();
			await act(async () => {
				deliver({ history: [], has_more: false });
			});

			expect(state.isLoadingMore).toBe(false);

			// And the next page is asked for rather than refused.
			mockState.chatMessagesHistory.mockResolvedValue({
				history: [{ type: "message", content: "Earlier question" }],
				has_more: false,
			});
			await act(async () => {
				await state.loadMore();
			});
			expect(state.messages[0]).toMatchObject({
				role: "user",
				content: "Earlier question",
			});
		});

		it("asks for the page the server pointed at, not one it worked out itself", async () => {
			// The page starts on a record with no seq of its own, so a cursor
			// derived from the transcript would name the wrong record — or none.
			subscribeWith([{ type: "text", content: "tail" }]);
			mockState.chatMessagesHistory.mockResolvedValue({
				history: [{ type: "message", content: "Earlier question" }],
				has_more: false,
			});

			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));

			await act(async () => {
				await state.loadMore();
			});

			expect(mockState.chatMessagesHistory).toHaveBeenCalledWith("s1", 7);
			expect(state.messages[0]).toMatchObject({
				role: "user",
				content: "Earlier question",
			});
			expect(state.hasMoreHistory).toBe(false);
		});

		it("brings an older page up to date with what the loaded pages already answered", async () => {
			// The result of the call landed in the page that was loaded first, so
			// the older page on its own still shows the call as running.
			subscribeWith([
				{ type: "tool_result", tool_use_id: "t1", tool_result: "file body" },
			]);
			mockState.chatMessagesHistory.mockResolvedValue({
				history: [
					{ type: "message", content: "Read it" },
					{ type: "tool_call", tool_use_id: "t1", tool_name: "Read" },
				],
				has_more: false,
			});

			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await act(async () => {
				await state.loadMore();
			});

			const answer = state.messages.at(-1) as AssistantMessage;
			expect(answer.parts).toMatchObject([
				{ type: "tool_call", tool: { result: "file body" } },
			]);
		});

		it("hands the record that ended a turn down to the page that turn is on", async () => {
			// The loaded page opens on the `error` that ended the turn below it, and
			// so replays without it. The older page must not come back claiming the
			// turn finished normally.
			subscribeWith([
				{ type: "error", error: "boom" },
				{ type: "message", content: "Next" },
			]);
			mockState.chatMessagesHistory.mockResolvedValue({
				history: [
					{ type: "message", content: "Explain" },
					{ type: "text", content: "half an answer" },
				],
				has_more: false,
			});

			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await act(async () => {
				await state.loadMore();
			});

			expect(state.messages[1]).toMatchObject({
				role: "assistant",
				status: "error",
				error: "boom",
			});
		});

		it("says why an earlier page is missing rather than passing it off as the start", async () => {
			subscribeWith([{ type: "text", content: "tail" }]);
			mockState.chatMessagesHistory.mockRejectedValue(
				new Error("invalid history cursor: 7"),
			);

			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await act(async () => {
				await state.loadMore();
			});

			expect(state.historyError).toContain("invalid history cursor: 7");
			// Still more to load: a failure is not the beginning of the session.
			expect(state.hasMoreHistory).toBe(true);
		});

		it("does not page while a page is already in flight", async () => {
			subscribeWith([{ type: "text", content: "tail" }]);
			let release: (() => void) | undefined;
			mockState.chatMessagesHistory.mockImplementation(
				() =>
					new Promise((resolve) => {
						release = () => resolve({ history: [], has_more: false });
					}),
			);

			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));

			await act(async () => {
				state.loadMore();
				state.loadMore();
			});
			expect(mockState.chatMessagesHistory).toHaveBeenCalledTimes(1);

			await act(async () => {
				release?.();
			});
		});
	});

	// The one source rule, at the point where it used to be broken: mode, agent
	// type, model and effort were once reported by the chat subscription and the
	// session list as well, and reading them from more than one place is how a
	// rejected change came back as two answers that disagreed.
	describe("session settings", () => {
		// The panel's subscription is what fills this store; the chat only reads it.
		const seedDetail = (id: string, overrides: Partial<SessionDetail> = {}) =>
			useSessionDetailStore
				.getState()
				.setDetail(id, makeSessionDetail({ id, ...overrides }));

		function renderSettings(sessionId = "s1") {
			const state: {
				mode: string;
				agentType: string;
				model: string;
				effort: string;
				activated: boolean;
				loaded: boolean;
			} = {
				mode: "default",
				agentType: "claude",
				model: "",
				effort: "",
				activated: false,
				loaded: false,
			};
			function SettingsProbe({ id }: { id: string }) {
				const chat = useChatMessages({ sessionId: id });
				state.mode = chat.mode;
				state.agentType = chat.agentType;
				state.model = chat.model;
				state.effort = chat.effort;
				state.activated = chat.isSessionActivated;
				state.loaded = chat.isSessionDetailLoaded;
				return null;
			}
			const view = render(<SettingsProbe id={sessionId} />);
			const rerender = (id: string) => view.rerender(<SettingsProbe id={id} />);
			return { state, rerender };
		}

		it("reads the settings from the session, not from the chat subscription", () => {
			seedDetail("s1", {
				agent_type: "codex",
				model: "gpt-5",
				effort: "high",
				mode: "yolo",
				activated: true,
			});

			const { state } = renderSettings();

			expect(state.loaded).toBe(true);
			expect(state).toMatchObject({
				mode: "yolo",
				agentType: "codex",
				model: "gpt-5",
				effort: "high",
				activated: true,
			});
		});

		// A setting the server took arrives as a new snapshot in the store, and the
		// chat has to show it: nothing applies a setting locally, so a value read
		// once at mount would leave the control on the old one forever.
		it("follows a change to the session's detail", () => {
			seedDetail("s1");
			const { state } = renderSettings();
			expect(state.loaded).toBe(true);

			act(() => {
				seedDetail("s1", { model: "haiku", mode: "yolo" });
			});

			expect(state.model).toBe("haiku");
			expect(state.mode).toBe("yolo");
		});

		// The settings of the session just left must never be shown under the name
		// of the one just opened — the whole reason the detail is read through a
		// selector that checks whose it is.
		it("shows no settings for a session whose snapshot has not arrived", () => {
			seedDetail("s1", { model: "opus" });

			const { state, rerender } = renderSettings("s1");
			expect(state.model).toBe("opus");

			rerender("s2");

			expect(state.model).toBe("");
			expect(state.loaded).toBe(false);
		});
	});
});
