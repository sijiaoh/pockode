import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
	ServerNotification,
	UserMessage,
} from "../types/message";
import { isForkableMessage } from "../utils/forkAnchor";
import { useChatMessages } from "./useChatMessages";

const mockState = vi.hoisted(() => ({
	chatMessagesSubscribe: vi.fn(),
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
		mockState.chatMessagesSubscribe.mockImplementation(
			async (sessionId: string) => ({
				id: `sub-${sessionId}`,
				initial: {
					history: history(`message of ${sessionId}`),
					state: "ended",
					mode: "default",
					agent_type: "claude",
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
						mode: "default",
						agent_type: "claude",
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
});
