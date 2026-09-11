import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
	ServerNotification,
} from "../types/message";
import { useChatMessages } from "./useChatMessages";

const mockState = vi.hoisted(() => ({
	chatMessagesSubscribe: vi.fn(),
	chatMessagesHistory: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(async () => {}),
}));

vi.mock("../lib/wsStore", () => {
	const state = {
		status: "connected",
		actions: {
			chatMessagesSubscribe: mockState.chatMessagesSubscribe,
			chatMessagesHistory: mockState.chatMessagesHistory,
			chatMessagesUnsubscribe: mockState.chatMessagesUnsubscribe,
			sendMessage: vi.fn(),
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

vi.mock("../lib/sessionStore", () => ({
	useSessionStore: (selector: (s: unknown) => unknown) =>
		selector({ sessions: [] }),
}));

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

describe("useChatMessages", () => {
	beforeEach(() => {
		committed.length = 0;
		mockState.chatMessagesHistory.mockReset();
		mockState.chatMessagesSubscribe.mockImplementation(
			async (sessionId: string) => ({
				id: `sub-${sessionId}`,
				initial: {
					history: history(`message of ${sessionId}`),
					state: "ended",
					mode: "default",
					agent_type: "claude",
					model: "",
					effort: "",
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
				mode: "default",
				agent_type: "claude",
				model: "",
				effort: "",
			},
		}));

		let latest: Message[] = [];
		let send: (content: string) => Promise<boolean> = async () => false;
		function SendProbe() {
			const { messages, sendUserMessage } = useChatMessages({
				sessionId: "s1",
			});
			latest = messages;
			send = sendUserMessage;
			return null;
		}

		render(<SendProbe />);
		await waitFor(() => expect(latest).toHaveLength(2));

		await act(async () => {
			await send("Still there?");
		});

		expect(latest.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
		expect((latest.at(-1) as AssistantMessage).status).toBe("sending");
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
						mode: "default",
						agent_type: "claude",
						model: "",
						effort: "",
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
					mode: "default",
					agent_type: "claude",
					model: "",
					effort: "",
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
});
