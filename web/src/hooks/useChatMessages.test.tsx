import { act, render, waitFor } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import {
	changedTool,
	ended,
	msg,
	nextSeq,
	noTurn,
	page,
	resetItems,
	text,
	thinking,
	tool,
	turn,
	update,
} from "../test/chatItemsFixture";
import { makeSessionDetail } from "../test/sessionFixtures";
import type { ChatPage, MessageItem, PageTurn } from "../types/chatItems";
import type {
	AssistantMessage,
	ChatNotification,
	Message,
	QuestionAnswerRecord,
	SessionDetail,
	UserMessage,
} from "../types/message";
import { isForkableMessage } from "../utils/forkAnchor";
import { useChatMessages } from "./useChatMessages";

const mockState = vi.hoisted(() => ({
	/** Drives a reconnect: see `reconnect` below. */
	status: "connected",
	/** `AuthResult.server_instance` of the connection that is up. */
	serverInstance: "",
	chatMessagesSubscribe: vi.fn(),
	chatMessagesHistory: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(async () => {}),
	// Mirrors ChatActions.sendMessage: it resolves once the server has the
	// message, and says nothing more — the record arrives on the subscription.
	sendMessage: vi.fn(
		(
			_sessionId: string,
			_messageId: string,
			_content: string,
			..._rest: unknown[]
		): Promise<void> => Promise.resolve(),
	),
	sendHtmlAction: vi.fn(
		(_sessionId: string, _messageId: string, _action: unknown): Promise<void> =>
			Promise.resolve(),
	),
	invalidateCommandCache: vi.fn(),
}));

vi.mock("../lib/wsStore", () => {
	const state = {
		get status() {
			return mockState.status;
		},
		get serverInstance() {
			return mockState.serverInstance;
		},
		actions: {
			chatMessagesSubscribe: mockState.chatMessagesSubscribe,
			chatMessagesHistory: mockState.chatMessagesHistory,
			chatMessagesUnsubscribe: mockState.chatMessagesUnsubscribe,
			sendMessage: mockState.sendMessage,
			sendHtmlAction: mockState.sendHtmlAction,
			invalidateCommandCache: mockState.invalidateCommandCache,
		},
	};
	const store = ((selector: (s: unknown) => unknown) =>
		selector(state)) as unknown as {
		(selector: (s: unknown) => unknown): unknown;
		getState: () => typeof state;
	};
	store.getState = () => state;
	return {
		useWSStore: store,
		// The real check reads the JSON-RPC code, which is all the tests vary.
		isInvalidParamsRejection: (error: unknown) =>
			error instanceof JSONRPCErrorException &&
			error.code === JSONRPCErrorCode.InvalidParams,
		isServerRejection: (error: unknown) =>
			error instanceof JSONRPCErrorException && error.code !== 0,
		isPermissionReviewerRejection: (error: unknown) =>
			error instanceof JSONRPCErrorException &&
			error.code === JSONRPCErrorCode.InvalidParams &&
			(error.data as { reason?: unknown } | undefined)?.reason ===
				"permission_reviewer",
	};
});

function setDetailTurn(sessionId: string, turn: SessionDetail["turn"]) {
	useSessionDetailStore
		.getState()
		.setDetail(sessionId, makeSessionDetail({ id: sessionId, turn }));
}

const IDLE = { phase: "idle", open: false, since: "" } as const;
const RUNNING_TURN = { phase: "running", open: true, since: "" } as const;

/** Where the transcript's subscription, whichever it is, is told things. */
let notifySubscriber: (n: ChatNotification) => void = () => {};

/**
 * The server's half of a send: the message's record, broadcast to every
 * subscriber — the sender too — under the id the client sent it with.
 */
function broadcastRecord(
	messageId: string,
	content: string,
	fields: Partial<MessageItem> = {},
) {
	const item = msg(content, { message_id: messageId, ...fields });
	notifySubscriber(update({ items: [item] }));
	return item;
}

/** Answers every `chat.message` as the server does: recorded, then replied to. */
function recordSends(
	fields: (content: string) => Partial<MessageItem> = () => ({}),
) {
	mockState.sendMessage.mockImplementation(async (_s, id, content) => {
		broadcastRecord(id, content, fields(content));
	});
}

/** A subscription whose snapshot is `p`, handing the test its callback. */
function subscribeWith(
	p: () => ChatPage,
	rest: Record<string, unknown> = {},
): { notify: (n: ChatNotification) => void } {
	const handle = { notify: (_n: ChatNotification) => {} };
	mockState.chatMessagesSubscribe.mockImplementation(
		async (
			_sessionId: string,
			onNotification: (n: ChatNotification) => void,
		) => {
			handle.notify = onNotification;
			notifySubscriber = onNotification;
			return { id: "sub-1", initial: { ...p(), turn: IDLE, ...rest } };
		},
	);
	return handle;
}

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
	const send: {
		current: ReturnType<typeof useChatMessages>["sendUserMessage"];
	} = { current: async () => false };
	function SendProbe() {
		const { messages, sendUserMessage } = useChatMessages({ sessionId: "s1" });
		latest.messages = messages;
		send.current = sendUserMessage;
		return null;
	}
	render(<SendProbe />);
	return { latest, send };
}

function renderActionProbe() {
	const latest: { messages: Message[] } = { messages: [] };
	const send: {
		current: ReturnType<typeof useChatMessages>["sendHtmlAction"];
	} = { current: async () => {} };
	function ActionProbe() {
		const { messages, sendHtmlAction } = useChatMessages({ sessionId: "s1" });
		latest.messages = messages;
		send.current = sendHtmlAction;
		return null;
	}
	render(<ActionProbe />);
	return { latest, send };
}

function findAction(messages: Message[]): UserMessage | undefined {
	const found = messages.find((m) => m.role === "user" && m.htmlAction);
	return found?.role === "user" ? found : undefined;
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
		mockState.serverInstance = "";
		mockState.sendMessage.mockReset();
		mockState.sendMessage.mockResolvedValue();
		mockState.sendHtmlAction.mockReset();
		mockState.sendHtmlAction.mockResolvedValue();
		notifySubscriber = () => {};
		mockState.invalidateCommandCache.mockClear();
		mockState.chatMessagesHistory.mockReset();
		useSessionDetailStore.getState().clear();
		resetItems();
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				sessionId: string,
				onNotification: (n: ChatNotification) => void,
			) => {
				notifySubscriber = onNotification;
				return {
					id: `sub-${sessionId}`,
					initial: {
						...page([turn({}, msg(`message of ${sessionId}`), text("ok"))]),
						turn: IDLE,
					},
				};
			},
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

	// A session whose process died right after the message was persisted: its
	// turn never started, and nothing is on its way to answer it. Sending again
	// must not leave a blank reply behind under the first.
	it("leaves no blank bubble behind when the previous turn was never answered", async () => {
		subscribeWith(() => page([noTurn(msg("Anyone there?"))]));

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages).toHaveLength(1));

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

	// A fork names its cut by the record's seq, which the echo gets once its
	// own record arrives — on the subscription, like every other tab's.
	it("can fork from a message it just sent once its record arrives", async () => {
		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		await act(async () => {
			await send.current("Try again");
		});
		// Sent, and not recorded yet: nothing to cut at.
		expect(isForkableMessage(findSent(latest.messages))).toBe(false);

		const [, id] = mockState.sendMessage.mock.calls[0];
		let record = msg("");
		act(() => {
			record = broadcastRecord(id, "Try again");
		});

		const sent = findSent(latest.messages);
		expect(sent.anchorSeq).toBe(record.seq);
		expect(isForkableMessage(sent)).toBe(true);
	});

	// The echo is the sender's own message from the first frame, under the id
	// it is sent with — the id its record will carry.
	it("sends under the id the echo is drawn with", async () => {
		recordSends();
		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		await act(async () => {
			await send.current("Try again");
		});

		const [, id] = mockState.sendMessage.mock.calls[0];
		const sent = findSent(latest.messages);
		expect(sent).toMatchObject({ id, messageId: id });
		expect(
			latest.messages.filter(
				(m) => m.role === "user" && m.content === "Try again",
			),
		).toHaveLength(1);
	});

	// The reply this message opens is drawn from the echo's placeholder, and
	// counted from the moment its record carries
	// (docs/tool-call-ui.md#where-the-duration-comes-from).
	it("starts the reply it opened at the moment its record carries", async () => {
		recordSends(() => ({ observed_at: "2026-01-01T00:00:01Z" }));

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		await act(async () => {
			await send.current("Try again");
		});

		const reply = latest.messages.at(-1) as AssistantMessage;
		expect(reply.role).toBe("assistant");
		expect(reply.openedAt).toBe(Date.parse("2026-01-01T00:00:01Z"));
	});

	// Drawn from what was typed until the record brings the prompt the agent
	// was actually sent.
	it("echoes a Pockode command as the command and fills in its prompt from the record", async () => {
		let reply: () => void = () => {};
		mockState.sendMessage.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				reply = resolve;
			}),
		);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		let sending: Promise<boolean> = Promise.resolve(false);
		act(() => {
			sending = send.current("/pockode-lead backend first");
		});

		const echo = () =>
			latest.messages.find((m) => m.role === "user" && m.command);
		expect(echo()).toMatchObject({
			content: "",
			command: { name: "pockode-lead", args: "backend first" },
		});

		// A parse of its own, so the test can tell whose the row ends up with.
		const [, id] = mockState.sendMessage.mock.calls[0];
		let record = msg("");
		await act(async () => {
			record = broadcastRecord(id, "Lead the work…", {
				command: { name: "pockode-lead", args: "server's parse" },
			});
			reply();
			await sending;
		});

		expect(echo()).toMatchObject({
			id,
			content: "Lead the work…",
			command: { name: "pockode-lead", args: "server's parse" },
			anchorSeq: record.seq,
		});
	});

	// The server writes an answering message's body, so the echo starts empty
	// and takes the body from its record.
	it("fills an answer's echo with the body the server wrote", async () => {
		const answering: QuestionAnswerRecord[] = [
			{
				request_id: "q1",
				question: "Which?",
				answers: ["SQLite"],
				answered_at: "2026-01-01T00:00:00Z",
			},
		];
		recordSends(() => ({
			content: "Answering:\n\nQ: Which?\nA: SQLite",
			answering,
		}));

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
		await act(async () => {
			await send.current("", answering);
		});

		const [, id] = mockState.sendMessage.mock.calls[0];
		expect(latest.messages.find((m) => m.id === id)).toMatchObject({
			content: "Answering:\n\nQ: Which?\nA: SQLite",
			answering,
		});
	});

	// The echo has only the browser's guess at each file; the record has what
	// the server read from the stored bytes, and that is what stays on screen.
	it("sends files by id and fills their echo from the record", async () => {
		recordSends(() => ({
			attachments: [
				{
					name: "shot.png",
					mime: "image/png",
					size: 5,
					width: 3,
					height: 2,
					attachment_id: "abc.png",
				},
			],
		}));
		const file = { id: "abc.png", name: "shot.png", size: 5, mime: "" };

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
		await act(async () => {
			await send.current("", undefined, [file]);
		});

		expect(mockState.sendMessage).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			"",
			undefined,
			[{ id: "abc.png", name: "shot.png" }],
		);
		expect(
			latest.messages.find((m) => m.role === "user" && m.attachments),
		).toMatchObject({
			attachments: [{ mime: "image/png", width: 3, attachment_id: "abc.png" }],
		});
	});

	// The files are the composer's to keep when the server refuses them — an
	// agent that cannot receive files, an id the session does not have.
	it("takes a refused message with files back out and rethrows", async () => {
		mockState.sendMessage.mockRejectedValueOnce(
			new JSONRPCErrorException(
				"this session's agent cannot receive attached files",
				JSONRPCErrorCode.InvalidParams,
			),
		);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
		const before = latest.messages;

		await act(async () => {
			await expect(
				send.current("look", undefined, [
					{ id: "x", name: "x.png", size: 1, mime: "image/png" },
				]),
			).rejects.toThrow("cannot receive attached files");
		});

		expect(latest.messages).toEqual(before);
	});

	// A refused command was never written or delivered, so leaving its echo up
	// would claim otherwise; the caller is the one that tells the user why.
	it("takes a refused Pockode command back out and rethrows", async () => {
		mockState.sendMessage.mockRejectedValueOnce(
			new JSONRPCErrorException(
				'Unknown Pockode command "/pockode-foo".',
				JSONRPCErrorCode.InvalidParams,
			),
		);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
		const before = latest.messages;

		await act(async () => {
			await expect(send.current("/pockode-foo")).rejects.toThrow(
				"Unknown Pockode command",
			);
		});

		expect(latest.messages).toEqual(before);
	});

	// The server records a slash command's use only once the send has gone
	// through, so a palette list cached before then would be missing it.
	it("drops the cached command list only after a slash command is accepted", async () => {
		let reply: () => void = () => {};
		mockState.sendMessage.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				reply = resolve;
			}),
		);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		let sending: Promise<boolean> = Promise.resolve(false);
		act(() => {
			sending = send.current("/review");
		});
		expect(mockState.invalidateCommandCache).not.toHaveBeenCalled();

		await act(async () => {
			reply();
			await sending;
		});
		expect(mockState.invalidateCommandCache).toHaveBeenCalledOnce();

		await act(async () => {
			await send.current("hello");
		});
		expect(mockState.invalidateCommandCache).toHaveBeenCalledOnce();
	});

	// A send that never got an answer may still have reached the agent, so it
	// is not taken back: the row stays, with the failure reported under it.
	it("keeps a Pockode command whose send failed without a refusal", async () => {
		mockState.sendMessage.mockRejectedValueOnce(
			new JSONRPCErrorException("Request timed out", 0),
		);

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		let ok = true;
		await act(async () => {
			ok = await send.current("/pockode-lead");
		});

		expect(ok).toBe(false);
		expect(
			latest.messages.find((m) => m.role === "user" && m.command),
		).toBeDefined();
		expect(latest.messages.at(-1)).toMatchObject({
			role: "assistant",
			status: "error",
			error: "Failed to send message: Request timed out",
		});
	});

	// A Task subagent keeps talking for a moment after the user stops the turn.
	// `turnOpen` is what blocks the composer and shows the Stop button, and it
	// reads the session's turn rather than the last bubble's status — so late
	// output cannot revive it, and a stopped session cannot look like a running
	// one.
	it("follows the session's turn, not the last message", async () => {
		let t: PageTurn | undefined;
		const sub = subscribeWith(
			() => {
				t = turn({ ended: false }, msg("Do the thing"), text("Working"));
				return page([t]);
			},
			{ turn: RUNNING_TURN },
		);

		let open = false;
		function StreamProbe() {
			const { turnOpen } = useChatMessages({ sessionId: "s1" });
			open = turnOpen;
			return null;
		}

		setDetailTurn("s1", RUNNING_TURN);
		render(<StreamProbe />);
		await waitFor(() => expect(open).toBe(true));

		// The turn ends where it really ends: in the session's state.
		act(() => setDetailTurn("s1", IDLE));
		expect(open).toBe(false);

		act(() =>
			sub.notify(
				update({ items: [text("Task finished")], turnId: t?.turn?.turn_id }),
			),
		);
		expect(open).toBe(false);
	});

	// The window this subscription cannot afford to have: the server registers
	// the subscription before it cuts the page, and writes the reply and any
	// notification from different goroutines. An update sent in between can
	// arrive before the reply — applied straight away it would be wiped out by
	// the snapshot landing after it.
	it("keeps an update that arrives before the page does", async () => {
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ChatNotification) => void,
			) => {
				const t = turn({ ended: false }, msg("Do the thing"));
				const snapshot = page([t]);
				onNotification(
					update({
						items: [text("written meanwhile")],
						turnId: t.turn?.turn_id,
					}),
				);
				return { id: "sub-1", initial: { ...snapshot, turn: RUNNING_TURN } };
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);

		await waitFor(() =>
			expect(messages.at(-1)).toMatchObject({
				role: "assistant",
				parts: [{ type: "text", content: "written meanwhile" }],
			}),
		);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: "Do the thing",
		});
	});

	// The same window seen from the other side: an update for a record written
	// before the page was cut is already in the page. Applied again it would
	// put a second copy of what it added in the transcript.
	it("does not apply an update the page already holds", async () => {
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ChatNotification) => void,
			) => {
				const t = turn({ ended: false }, msg("Do the thing"), text("once"));
				const held = update({ items: [t.items[1]], turnId: t.turn?.turn_id });
				const snapshot = page([t]);
				onNotification(held);
				return { id: "sub-1", initial: { ...snapshot, turn: RUNNING_TURN } };
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);

		await waitFor(() => expect(messages).toHaveLength(2));
		expect(messages[1]).toMatchObject({
			role: "assistant",
			parts: [{ type: "text", content: "once" }],
		});
	});

	// A phone reconnects mid-run as a matter of course, and what a call says
	// about itself is never recorded — so what a background call that started
	// half an hour ago is doing reaches a fresh subscription only in the reply.
	it("picks up what a call still in flight last reported", async () => {
		let call = tool("Bash");
		subscribeWith(
			() => {
				const asked = msg("Build it");
				call = tool(
					"Bash",
					{ command: "npm run build" },
					{
						tool_use_id: "t1",
						status: "background",
						backgrounded: true,
					},
				);
				return page([turn({ ended: false }, asked, call)]);
			},
			{
				turn: RUNNING_TURN,
				streams: {
					tools: { t1: { activity: "Compiling 120 modules" } },
				},
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);

		await waitFor(() => expect(messages.length).toBeGreaterThan(1));
		const reply = messages.at(-1) as AssistantMessage;
		expect(reply.parts[0]).toMatchObject({
			type: "tool_call",
			tool: {
				id: call.tool?.tool_use_id,
				status: "background",
				activity: "Compiling 120 modules",
			},
		});
	});

	// Progress can arrive faster than the screen refreshes, so it is held for
	// one frame — and what the frame applies has to be all of it, in order.
	it("applies deltas that arrived within one frame in order", async () => {
		const sub = subscribeWith(
			() =>
				page([
					turn(
						{ ended: false },
						msg("Build it"),
						tool("Bash", {}, { tool_use_id: "t1", status: "running" }),
					),
				]),
			{ turn: RUNNING_TURN },
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);
		await waitFor(() => expect(messages.length).toBeGreaterThan(1));

		act(() => {
			sub.notify({
				type: "delta",
				tool: { tool_use_id: "t1", output: "one\n", activity: "Compiling" },
			});
			sub.notify({
				type: "delta",
				tool: { tool_use_id: "t1", output: "two\n", activity: "Bundling" },
			});
		});

		await waitFor(() => {
			const reply = messages.at(-1) as AssistantMessage;
			// The output accumulates and the activity is a latest value, which
			// is what lets the frame hold them merged instead of queued.
			expect(reply.parts[0]).toMatchObject({
				type: "tool_call",
				tool: { output: "one\ntwo\n", activity: "Bundling" },
			});
		});
	});

	// An update ending a call's stream is never followed by the output still
	// held for the frame: it was the call's, and the call is over.
	it("applies held deltas before the update that ends their stream", async () => {
		let call = tool("Bash");
		let t: PageTurn | undefined;
		const sub = subscribeWith(
			() => {
				const asked = msg("Build it");
				call = tool("Bash", {}, { status: "running" });
				t = turn({ ended: false }, asked, call);
				return page([t]);
			},
			{ turn: RUNNING_TURN },
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);
		await waitFor(() => expect(messages.length).toBeGreaterThan(1));
		const id = call.tool?.tool_use_id ?? "";

		act(() => {
			sub.notify({
				type: "delta",
				tool: { tool_use_id: id, output: "late\n" },
			});
			sub.notify(
				update({
					items: [
						changedTool(call, {
							status: "succeeded",
							result: { text: "done" },
						}),
					],
					turnId: t?.turn?.turn_id,
					streams_ended: { tools: [id] },
				}),
			);
		});
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);

		const reply = messages.at(-1) as AssistantMessage;
		expect(reply.parts[0]).toMatchObject({
			type: "tool_call",
			tool: { status: "success", result: "done" },
		});
		expect(
			(reply.parts[0] as { tool: { output?: string } }).tool.output,
		).toBeUndefined();
	});

	// `chat.resync`: the server could not tell this subscriber something and
	// will send nothing more on it. What it lost here is the turn's end, so
	// without a fresh snapshot the bubble would stream forever.
	it("replaces the transcript with a fresh subscription's snapshot on resync", async () => {
		// A copy that could be resumed, which a resync must not resume: the
		// hole it reports is one the copy cannot vouch past.
		mockState.serverInstance = "instance-1";
		let notify: (notification: ChatNotification) => void = () => {};
		let subscriptions = 0;
		mockState.chatMessagesUnsubscribe.mockClear();
		const asked = msg("Do the thing");
		const working = text("Working");
		const open = turn({ ended: false }, asked, working);
		const first = page([open]);
		const done = text("and done");
		const finished = page([
			{ ...open, items: [asked, working, done], turn: ended(open).turn },
		]);
		mockState.chatMessagesSubscribe.mockImplementation(
			async (
				_sessionId: string,
				onNotification: (notification: ChatNotification) => void,
			) => {
				notify = onNotification;
				subscriptions++;
				return subscriptions === 1
					? { id: "sub-1", initial: { ...first, turn: RUNNING_TURN } }
					: { id: "sub-2", initial: { ...finished, turn: IDLE } };
			},
		);

		let messages: Message[] = [];
		function Probe() {
			messages = useChatMessages({ sessionId: "s1" }).messages;
			return null;
		}
		render(<Probe />);
		await waitFor(() =>
			expect(messages.at(-1)).toMatchObject({ status: "streaming" }),
		);

		await act(async () => notify({ type: "resync" }));

		await waitFor(() =>
			expect(messages.at(-1)).toMatchObject({ status: "complete" }),
		);
		expect(mockState.chatMessagesUnsubscribe).toHaveBeenCalledWith("sub-1");
		expect(subscriptions).toBe(2);
		expect(mockState.chatMessagesSubscribe.mock.calls[1][2]).toBeUndefined();
		// Replaced, not appended to.
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			parts: [{ type: "text", content: "Working\n\nand done" }],
		});
	});

	describe("a message it sent", () => {
		// The bubble the user watched appear is the one that stays, under the
		// same keys, once the record carrying its id arrives.
		it("keeps its bubbles when the transcript takes the message in", async () => {
			const sub = subscribeWith(() => page([turn({}, msg("before"))]));

			const { latest, send } = renderSendProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
			await act(async () => {
				await send.current("Try again");
			});
			const [echo, reply] = latest.messages.slice(-2);
			expect(reply).toMatchObject({ role: "assistant", status: "sending" });

			const [, id] = mockState.sendMessage.mock.calls[0];
			const recorded = msg("Try again", { message_id: id });
			act(() =>
				sub.notify(
					update({
						turns: [
							{
								turn: {
									turn_id: "t-sent",
									origin: "prompt",
									message_id: id,
									start_seq: recorded.seq,
									ended: false,
								},
							},
						],
						items: [{ item: recorded, turn_id: "t-sent" }],
					}),
				),
			);
			const after = latest.messages.slice(-2);
			expect(after.map((m) => m.id)).toEqual([echo.id, reply.id]);
			expect(after[1]).toMatchObject({ status: "streaming" });
			expect(
				latest.messages.filter(
					(m) => m.role === "user" && m.content === "Try again",
				),
			).toHaveLength(1);
		});

		// Its record may arrive before the reply does, or after a reply lost
		// with the connection: either way, it is the message, not a failure.
		it("is reconciled by its record when the reply never comes", async () => {
			mockState.sendMessage.mockImplementationOnce(async (_s, id, content) => {
				broadcastRecord(id, content);
				throw new JSONRPCErrorException("Connection lost", 0);
			});
			const { latest, send } = renderSendProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			await act(async () => {
				await send.current("Try again");
			});

			expect(
				latest.messages.filter(
					(m) => m.role === "user" && m.content === "Try again",
				),
			).toHaveLength(1);
			expect(
				latest.messages.some((m) => m.role === "assistant" && m.error),
			).toBe(false);
		});

		// The record is written before the message is handed to the agent, so a
		// failure the server answers with outlives the record reaching this tab.
		it("keeps a failure the server answered with, though its record arrived", async () => {
			mockState.sendMessage.mockImplementationOnce(async (_s, id, content) => {
				broadcastRecord(id, content);
				throw new JSONRPCErrorException(
					"stdin closed",
					JSONRPCErrorCode.InternalError,
				);
			});
			const { latest, send } = renderSendProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			await act(async () => {
				await send.current("Try again");
			});

			expect(
				latest.messages.filter(
					(m) => m.role === "user" && m.content === "Try again",
				),
			).toHaveLength(1);
			expect(latest.messages.at(-1)).toMatchObject({
				role: "assistant",
				status: "error",
				error: "Failed to send message: stdin closed",
			});
		});

		// An answer is taken back when its send fails, for the sheet holds the
		// drafts — but not once its record is in: it was written, so it stays,
		// with the failure under it, and the sheet still hears.
		it("keeps a failed answer whose record arrived, and rethrows", async () => {
			const answering: QuestionAnswerRecord[] = [
				{
					request_id: "q1",
					question: "Which?",
					answers: ["SQLite"],
					answered_at: "2026-01-01T00:00:00Z",
				},
			];
			mockState.sendMessage.mockImplementationOnce(async (_s, id) => {
				broadcastRecord(id, "Answering:\n\nQ: Which?\nA: SQLite", {
					answering,
				});
				throw new JSONRPCErrorException(
					"stdin closed",
					JSONRPCErrorCode.InternalError,
				);
			});
			const { latest, send } = renderSendProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			await act(async () => {
				await expect(send.current("", answering)).rejects.toThrow(
					"stdin closed",
				);
			});

			const [, id] = mockState.sendMessage.mock.calls[0];
			expect(latest.messages.find((m) => m.id === id)).toMatchObject({
				answering,
			});
			expect(latest.messages.at(-1)).toMatchObject({
				role: "assistant",
				status: "error",
				error: "Failed to send message: stdin closed",
			});
		});

		// Only the server can say a recorded answer never reached the agent; a
		// reply lost with the connection says nothing of the kind.
		it("draws an answer whose record arrived as sent when only the connection failed", async () => {
			const answering: QuestionAnswerRecord[] = [
				{
					request_id: "q1",
					question: "Which?",
					answers: ["SQLite"],
					answered_at: "2026-01-01T00:00:00Z",
				},
			];
			mockState.sendMessage.mockImplementationOnce(async (_s, id) => {
				broadcastRecord(id, "Answering:\n\nQ: Which?\nA: SQLite", {
					answering,
				});
				throw new Error("Connection lost");
			});
			const { latest, send } = renderSendProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			await act(async () => {
				await expect(send.current("", answering)).rejects.toThrow(
					"Connection lost",
				);
			});

			const [, id] = mockState.sendMessage.mock.calls[0];
			expect(latest.messages.find((m) => m.id === id)).toMatchObject({
				answering,
			});
			expect(latest.messages.some((m) => m.status === "error")).toBe(false);
		});
	});

	describe("a page's send", () => {
		const ACTION = { page: "p3", action: "approve", data: { id: "42" } };

		// Drawn from the action at once; the agent's text is the server's, and
		// arrives with the record.
		it("is echoed as the action, then filled in from its record", async () => {
			const { latest, send } = renderActionProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			await act(async () => {
				await send.current(ACTION);
			});
			expect(mockState.sendHtmlAction).toHaveBeenCalledWith(
				"s1",
				expect.any(String),
				ACTION,
			);
			const [, id] = mockState.sendHtmlAction.mock.calls[0];
			expect(findAction(latest.messages)).toMatchObject({
				id,
				content: "",
				htmlAction: ACTION,
			});

			let record = msg("");
			act(() => {
				record = broadcastRecord(
					id,
					'Page action "approve" from p3:\n{"id":"42"}',
					{
						html_action: ACTION,
					},
				);
			});
			expect(findAction(latest.messages)).toMatchObject({
				id,
				content: 'Page action "approve" from p3:\n{"id":"42"}',
				messageId: id,
				anchorSeq: record.seq,
			});
		});

		// Nothing was recorded, and the page that sent says why under its card.
		it("takes a refused send back out and rethrows", async () => {
			mockState.sendHtmlAction.mockRejectedValueOnce(
				new JSONRPCErrorException(
					"page p9 does not exist in this session",
					JSONRPCErrorCode.InvalidParams,
				),
			);
			const { latest, send } = renderActionProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
			const before = latest.messages;

			await act(async () => {
				await expect(send.current(ACTION)).rejects.toThrow("page p9");
			});
			expect(latest.messages).toEqual(before);
		});

		// It may have been delivered, so it stays — and the page still hears.
		it("keeps a send that failed without a refusal, and rethrows", async () => {
			mockState.sendHtmlAction.mockRejectedValueOnce(
				new JSONRPCErrorException("Request timed out", 0),
			);
			const { latest, send } = renderActionProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			await act(async () => {
				await expect(send.current(ACTION)).rejects.toThrow("timed out");
			});
			expect(findAction(latest.messages)).toBeDefined();
			expect(latest.messages.at(-1)).toMatchObject({
				role: "assistant",
				status: "error",
				error: "Failed to send message: Request timed out",
			});
		});
	});

	// The tail line's half of the hook: what the main agent is thinking now is
	// state of its own beside the transcript, and its clock is the server's
	// reading carried over to this device (docs/turn-progress-ui.md §2.3).
	describe("the tail line", () => {
		const RUNNING = {
			phase: "running" as const,
			open: true,
			since: "2024-01-01T00:00:00Z",
		};

		function renderTail(streams?: Record<string, unknown>) {
			let t: PageTurn | undefined;
			const sub = subscribeWith(
				() => {
					t = turn({ ended: false }, msg("Go"));
					return page([t]);
				},
				{ turn: RUNNING, ...(streams ? { streams } : {}) },
			);
			setDetailTurn("s1", RUNNING);
			const latest = {} as ReturnType<typeof useChatMessages>;
			function TailProbe() {
				Object.assign(latest, useChatMessages({ sessionId: "s1" }));
				return null;
			}
			render(<TailProbe />);
			const emit = (...notifications: ChatNotification[]) =>
				act(() => {
					for (const n of notifications) sub.notify(n);
				});
			const turnId = () => t?.turn?.turn_id;
			return { latest, emit, turnId };
		}

		const delta = (content: string): ChatNotification => ({
			type: "delta",
			thinking: { content },
		});

		it("gathers the deltas, and ends where the update says the stream did", async () => {
			const { latest, emit, turnId } = renderTail();
			await waitFor(() => expect(latest.isLoadingHistory).toBe(false));

			emit(delta(""), delta("**Plan**\n\n"), delta("Read it"));
			await waitFor(() =>
				expect(latest.tail.thinking).toMatchObject({
					content: "**Plan**\n\nRead it",
				}),
			);

			// A subagent's thinking is an item of its own and ends nothing.
			emit(update({ items: [thinking("sub", "task-1")], turnId: turnId() }));
			expect(latest.tail.thinking).not.toBeNull();

			emit(
				update({
					items: [thinking("**Plan**\n\nRead it")],
					turnId: turnId(),
					streams_ended: { thinking: true },
				}),
			);
			expect(latest.tail.thinking).toBeNull();
			// Nor did the deltas reach the transcript: only the items did.
			const reply = latest.messages.at(-1) as AssistantMessage;
			expect(reply.parts.map((part) => part.type)).toEqual([
				"thinking",
				"thinking",
			]);
		});

		// A client subscribing mid-thought has all of it: the snapshot holds what
		// was thought so far, and the deltas continue it.
		it("starts from the thinking the subscription came with", async () => {
			const { latest, emit } = renderTail({
				thinking: { content: "Checking the " },
			});
			await waitFor(() =>
				expect(latest.tail.thinking).toMatchObject({
					content: "Checking the ",
				}),
			);
			emit(delta("sender"));
			await waitFor(() =>
				expect(latest.tail.thinking).toMatchObject({
					content: "Checking the sender",
				}),
			);
		});

		// A delta sent during the subscribe round trip is replayed after the
		// snapshot, and continues it rather than standing in for it.
		it("continues the subscription's thinking with a delta held across it", async () => {
			mockState.chatMessagesSubscribe.mockImplementation(
				async (_s: string, onNotification: (n: ChatNotification) => void) => {
					const t = turn({ ended: false }, msg("Go"));
					onNotification({ type: "delta", thinking: { content: "sender" } });
					return {
						id: "sub-1",
						initial: {
							...page([t]),
							turn: RUNNING,
							streams: { thinking: { content: "Checking the " } },
						},
					};
				},
			);
			setDetailTurn("s1", RUNNING);
			const latest = {} as ReturnType<typeof useChatMessages>;
			function TailProbe() {
				Object.assign(latest, useChatMessages({ sessionId: "s1" }));
				return null;
			}
			render(<TailProbe />);
			await waitFor(() =>
				expect(latest.tail.thinking).toMatchObject({
					content: "Checking the sender",
				}),
			);
		});

		// A subscriber that fell behind has deltas turned away, and the next one
		// it gets is the whole stream so far.
		it("takes a replacing delta as the whole thinking", async () => {
			const { latest, emit } = renderTail();
			await waitFor(() => expect(latest.isLoadingHistory).toBe(false));
			emit(delta("abc"));
			await waitFor(() => expect(latest.tail.thinking).not.toBeNull());
			emit({ type: "delta", thinking: { content: "abcdef", replace: true } });
			await waitFor(() =>
				expect(latest.tail.thinking).toMatchObject({ content: "abcdef" }),
			);
		});

		// Nothing closes what the user opened, and a thinking they were reading in
		// the panel becomes a row that is open.
		it("opens the row a thinking settles into under the open panel", async () => {
			const { latest, emit, turnId } = renderTail();
			await waitFor(() => expect(latest.isLoadingHistory).toBe(false));

			emit(delta(""), delta("Checking"));
			await waitFor(() => expect(latest.tail.thinking).not.toBeNull());
			act(() => latest.tail.panel.onToggle());
			expect(latest.tail.panel.expanded).toBe(true);

			emit(
				update({
					items: [thinking("Checking")],
					turnId: turnId(),
					streams_ended: { thinking: true },
				}),
				update({ items: [text("Done.")], turnId: turnId() }),
			);
			const reply = latest.messages.at(-1) as AssistantMessage;
			const row = reply.parts[0];
			if (row.type !== "thinking") throw new Error("no thinking row");
			expect(latest.openedThoughtIds.has(row.id)).toBe(true);
		});

		// The panel open on something else — the plan — never showed a thinking
		// with no text, so its row has nothing the reader was following.
		it("leaves closed the row of a thinking the open panel had no text for", async () => {
			const { latest, emit, turnId } = renderTail();
			await waitFor(() => expect(latest.isLoadingHistory).toBe(false));

			emit(delta(""));
			await waitFor(() => expect(latest.tail.thinking).not.toBeNull());
			act(() => latest.tail.panel.onToggle());
			emit(
				update({
					items: [thinking("Checking")],
					turnId: turnId(),
					streams_ended: { thinking: true },
				}),
			);
			expect(latest.openedThoughtIds.size).toBe(0);
		});

		// An update held across a subscribe that the page already holds is
		// skipped, and still ends the stream it says it ended.
		it("ends with an update the page already held", async () => {
			const { latest, emit } = renderTail({ thinking: { content: "x" } });
			await waitFor(() => expect(latest.tail.thinking).not.toBeNull());
			emit({
				type: "update",
				through_seq: 1,
				streams_ended: { thinking: true },
			});
			expect(latest.tail.thinking).toBeNull();
		});

		it("is not brought back by deltas still waiting for their frame", async () => {
			const { latest, emit, turnId } = renderTail();
			await waitFor(() => expect(latest.isLoadingHistory).toBe(false));

			emit(
				delta("late"),
				update({
					items: [thinking("late")],
					turnId: turnId(),
					streams_ended: { thinking: true },
				}),
			);
			await act(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => resolve()),
					),
			);
			expect(latest.tail.thinking).toBeNull();
		});

		// A restart leaves nothing to say the thinking ended.
		it("ends when the turn closes", async () => {
			const { latest, emit } = renderTail();
			await waitFor(() => expect(latest.isLoadingHistory).toBe(false));

			emit(delta("x"));
			await waitFor(() => expect(latest.tail.thinking).not.toBeNull());
			act(() => setDetailTurn("s1", IDLE));
			expect(latest.tail.thinking).toBeNull();
		});

		it("counts the turn's clock on from when the server's reading arrived", async () => {
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			try {
				const { latest } = renderTail();
				act(() => setDetailTurn("s1", { ...RUNNING, open_elapsed_ms: 64_000 }));
				expect(latest.tail.openedAt).toBe(1_000_000 - 64_000);
			} finally {
				now.mockRestore();
			}
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

		/** An older page, built before the newest so its items are older. */
		const older = () => page([turn({}, msg("Earlier question"), text("a"))]);

		function subscribeNewest() {
			subscribeWith(() =>
				page([turn({ continued: true }, text("tail"))], {
					has_more: true,
					next_before_seq: 7,
				}),
			);
		}

		// A phone reconnects mid-page as a matter of course, and the request it
		// interrupts learns it no longer speaks for this transcript and so skips
		// its own clean-up. Whatever the reconnect does not reset stays set for
		// good: the spinner would spin forever, and the transcript — which refuses
		// to ask while a page is on its way — would never page again.
		it("leaves paging usable when a reconnect interrupts a page in flight", async () => {
			const earlier = older();
			subscribeNewest();
			// The page the reconnect discards: it answers only after the fact.
			let deliver: (p: ChatPage) => void = () => {};
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
				deliver(page([]));
			});

			expect(state.isLoadingMore).toBe(false);

			// And the next page is asked for rather than refused.
			mockState.chatMessagesHistory.mockResolvedValue(earlier);
			await act(async () => {
				await state.loadMore();
			});
			expect(state.messages[0]).toMatchObject({
				role: "user",
				content: "Earlier question",
			});
		});

		/**
		 * Subscribes with the newest page, then answers each re-subscribe with
		 * what `again` returns; hands back what each subscribe was asked.
		 */
		function subscribeThen(again: () => Record<string, unknown>): {
			calls: () => unknown[][];
		} {
			let subscribes = 0;
			mockState.chatMessagesSubscribe.mockClear();
			mockState.chatMessagesSubscribe.mockImplementation(async () => {
				subscribes++;
				const initial =
					subscribes === 1
						? {
								...page([turn({ continued: true }, text("tail"))], {
									has_more: true,
									next_before_seq: 7,
								}),
								turn: IDLE,
								delivery: "snapshot",
							}
						: { turn: IDLE, ...again() };
				return { id: `sub-${subscribes}`, initial };
			});
			return { calls: () => mockState.chatMessagesSubscribe.mock.calls };
		}

		function contents(messages: Message[]): string[] {
			return messages.flatMap((m) =>
				m.role === "user"
					? [m.content]
					: m.parts.flatMap((p) => (p.type === "text" ? [p.content] : [])),
			);
		}

		// The point of resuming: a reconnect on a phone used to drop every page
		// the user had scrolled back through. Resumed from the same server
		// instance, the transcript keeps them and gains what it missed.
		it("keeps the pages paged in when a reconnect resumes", async () => {
			mockState.serverInstance = "instance-1";
			const earlier = older();
			const { calls } = subscribeThen(() => ({
				delivery: "resume",
				update: (({ type: _, ...u }) => u)(
					update({ items: [text("while away")] }),
				),
			}));
			mockState.chatMessagesHistory.mockResolvedValue(earlier);
			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await act(async () => {
				await state.loadMore();
			});
			const firstThrough = (
				(await mockState.chatMessagesSubscribe.mock.results[0].value) as {
					initial: { through_seq: number };
				}
			).initial.through_seq;

			await state.reconnect();

			await waitFor(() =>
				expect(contents(state.messages)).toContain("while away"),
			);
			expect(contents(state.messages)).toEqual(
				expect.arrayContaining(["Earlier question", "tail", "while away"]),
			);
			expect(calls()[0][2]).toBeUndefined();
			expect(calls()[1][2]).toEqual({
				server_instance: "instance-1",
				after_seq: firstThrough,
			});
			// The pages paged in are still paged in: there is nothing older.
			expect(state.hasMoreHistory).toBe(false);
		});

		// An older page asked for over the connection that dropped fails with
		// it, before the resume answers. The cursor it was asked with is still
		// good, so the failure must not be left stopping the next ask.
		it("clears an older page's failure that the dropped connection caused, on a resume", async () => {
			mockState.serverInstance = "instance-1";
			subscribeThen(() => ({
				delivery: "resume",
				update: (({ type: _, ...u }) => u)(update({})),
			}));
			mockState.chatMessagesHistory.mockRejectedValueOnce(
				new Error("Connection lost"),
			);
			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await act(async () => {
				await state.loadMore();
			});
			expect(state.historyError).toContain("Connection lost");

			await state.reconnect();

			await waitFor(() => expect(state.historyError).toBeNull());
			expect(state.hasMoreHistory).toBe(true);
		});

		// A send whose reply was lost with the connection may have been
		// recorded meanwhile. The resume brings what the copy missed — that
		// record among it — and the record takes the failed echo by its id,
		// rather than leaving a failure under a message the agent has.
		it("reconciles a send whose reply was lost, once a resume brings its record", async () => {
			mockState.serverInstance = "instance-1";
			subscribeWith(() => ({ ...page([turn({ ended: false }, msg("Go"))]) }), {
				delivery: "snapshot",
			});
			mockState.sendMessage.mockRejectedValueOnce(
				new JSONRPCErrorException("Connection lost", 0),
			);
			const state: {
				messages: Message[];
				send: ReturnType<typeof useChatMessages>["sendUserMessage"];
			} = { messages: [], send: async () => false };
			function ResumeProbe() {
				const chat = useChatMessages({ sessionId: "s1" });
				state.messages = chat.messages;
				state.send = chat.sendUserMessage;
				return null;
			}
			const { rerender } = render(<ResumeProbe />);
			await waitFor(() => expect(state.messages.length).toBeGreaterThan(0));
			const held = nextSeq() - 1;

			await act(async () => {
				await state.send("Hello there");
			});
			expect(
				state.messages.some((m) => m.role === "assistant" && m.error),
			).toBe(true);
			const [, id] = mockState.sendMessage.mock.calls[0];

			mockState.chatMessagesSubscribe.mockClear();
			mockState.chatMessagesSubscribe.mockImplementation(async () => ({
				id: "sub-2",
				initial: {
					turn: IDLE,
					delivery: "resume",
					update: (({ type: _, ...u }) => u)(
						update({
							items: [msg("Hello there", { message_id: id }), text("working")],
						}),
					),
				},
			}));
			for (const status of ["reconnecting", "connected"]) {
				mockState.status = status;
				await act(async () => {
					rerender(<ResumeProbe />);
				});
			}

			await waitFor(() =>
				expect(mockState.chatMessagesSubscribe).toHaveBeenCalled(),
			);
			// From what the copy holds: nothing of its own can be missing below it.
			expect(mockState.chatMessagesSubscribe.mock.calls[0][2]).toEqual({
				server_instance: "instance-1",
				after_seq: held,
			});
			await waitFor(() =>
				expect(
					state.messages.filter(
						(m) => m.role === "user" && m.content === "Hello there",
					),
				).toHaveLength(1),
			);
			expect(
				state.messages.find(
					(m) => m.role === "user" && m.content === "Hello there",
				)?.id,
			).toBe(id);
			expect(
				state.messages.some((m) => m.role === "assistant" && m.error),
			).toBe(false);
		});

		// Another server instance, or a gap it will not answer as an update:
		// the reply is a snapshot, and it replaces the copy, older pages and all.
		it("starts over when a reconnect is answered with a snapshot", async () => {
			mockState.serverInstance = "instance-1";
			const earlier = older();
			subscribeThen(() => ({
				...page([turn({ continued: true }, text("fresh"))], {
					has_more: true,
					next_before_seq: 9,
				}),
				delivery: "snapshot",
			}));
			mockState.chatMessagesHistory.mockResolvedValue(earlier);
			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await act(async () => {
				await state.loadMore();
			});
			expect(contents(state.messages)).toContain("Earlier question");

			mockState.serverInstance = "instance-2";
			await state.reconnect();

			await waitFor(() => expect(contents(state.messages)).toEqual(["fresh"]));
			expect(state.hasMoreHistory).toBe(true);
		});

		// Nothing is resumed that was not read from a known instance: a server
		// that predates server_instance gets the plain subscribe it always did.
		it("asks for a page when the copy names no server instance", async () => {
			const { calls } = subscribeThen(() => ({
				...page([turn({}, text("fresh"))]),
				delivery: "snapshot",
			}));
			const state = renderPager();
			await waitFor(() => expect(state.hasMoreHistory).toBe(true));
			await state.reconnect();
			await waitFor(() => expect(calls()).toHaveLength(2));
			expect(calls()[1][2]).toBeUndefined();
		});

		it("asks for the page the server pointed at, and puts it in front", async () => {
			const earlier = older();
			subscribeNewest();
			mockState.chatMessagesHistory.mockResolvedValue(earlier);

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

		it("says why an earlier page is missing rather than passing it off as the start", async () => {
			subscribeNewest();
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
			subscribeNewest();
			let release: (() => void) | undefined;
			mockState.chatMessagesHistory.mockImplementation(
				() =>
					new Promise((resolve) => {
						release = () => resolve(page([]));
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
