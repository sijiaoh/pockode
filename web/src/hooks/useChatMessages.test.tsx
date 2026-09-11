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
	chatMessagesUnsubscribe: vi.fn(async () => {}),
}));

vi.mock("../lib/wsStore", () => {
	const state = {
		status: "connected",
		actions: {
			chatMessagesSubscribe: mockState.chatMessagesSubscribe,
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
		mockState.chatMessagesSubscribe.mockImplementation(
			async (sessionId: string) => ({
				id: `sub-${sessionId}`,
				initial: {
					history: history(`message of ${sessionId}`),
					state: "ended",
					mode: "default",
					agent_type: "claude",
					model: "",
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
