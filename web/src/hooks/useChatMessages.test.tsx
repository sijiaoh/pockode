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
		status: "connected",
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
		mockState.sendMessage.mockReset();
		mockState.sendMessage.mockResolvedValue(undefined);
		mockState.chatMessagesHistory.mockReset();
		useSessionDetailStore.getState().clear();
		mockState.chatMessagesSubscribe.mockImplementation(
			async (sessionId: string) => ({
				id: `sub-${sessionId}`,
				initial: {
					history: history(`message of ${sessionId}`),
					state: "ended",
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
				state: "ended",
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
	// isStreaming is what blocks the composer and shows the Stop button, so a
	// late message reviving it makes a stopped session look like a running one.
	it("stays out of streaming when a late message follows an interrupt", async () => {
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
						state: "running",
					},
				};
			},
		);

		let streaming = false;
		function StreamProbe() {
			const { isStreaming } = useChatMessages({ sessionId: "s1" });
			streaming = isStreaming;
			return null;
		}

		render(<StreamProbe />);
		await waitFor(() => expect(streaming).toBe(true));

		act(() => notify?.({ type: "interrupted" } as ServerNotification));
		expect(streaming).toBe(false);

		act(() =>
			notify?.({
				type: "text",
				content: "Task finished",
			} as ServerNotification),
		);
		expect(streaming).toBe(false);
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
						state: "running",
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
						state: "running",
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
				historyError: string | null;
				loadMore: () => Promise<void>;
			} = {
				messages: [],
				hasMoreHistory: false,
				historyError: null,
				loadMore: async () => {},
			};
			function PageProbe() {
				const chat = useChatMessages({ sessionId: "s1" });
				state.messages = chat.messages;
				state.hasMoreHistory = chat.hasMoreHistory;
				state.historyError = chat.historyError;
				state.loadMore = chat.loadMoreHistory;
				return null;
			}
			render(<PageProbe />);
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
					state: "ended",
					...rest,
				},
			}));
		}

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
