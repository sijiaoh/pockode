import { act, render, waitFor } from "@testing-library/react";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SentMessage } from "../lib/rpc";
import type { SentHtmlAction } from "../lib/rpc/chat";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import {
	changedTool,
	ended,
	msg,
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
import type { ChatPage, PageTurn } from "../types/chatItems";
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
	chatMessagesSubscribe: vi.fn(),
	chatMessagesHistory: vi.fn(),
	chatMessagesUnsubscribe: vi.fn(async () => {}),
	// Mirrors ChatActions.sendMessage: it resolves with what the server said
	// about the message — its seq, when it has an address to give.
	sendMessage: vi.fn((): Promise<SentMessage> => Promise.resolve({})),
	sendHtmlAction: vi.fn((): Promise<SentHtmlAction> => Promise.resolve({})),
	invalidateCommandCache: vi.fn(),
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
		mockState.sendMessage.mockReset();
		mockState.sendMessage.mockResolvedValue({});
		mockState.sendHtmlAction.mockReset();
		mockState.sendHtmlAction.mockResolvedValue({});
		mockState.invalidateCommandCache.mockClear();
		mockState.chatMessagesHistory.mockReset();
		useSessionDetailStore.getState().clear();
		resetItems();
		mockState.chatMessagesSubscribe.mockImplementation(
			async (sessionId: string) => ({
				id: `sub-${sessionId}`,
				initial: {
					...page([turn({}, msg(`message of ${sessionId}`), text("ok"))]),
					turn: IDLE,
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

	// The message a client sends itself is the one it is never told the seq of:
	// the broadcast that carries every other record's address deliberately skips
	// the sender. Without the seq from the reply, forking from your own prompt —
	// the whole point of the action, right when the answer disappoints — stays
	// greyed out until the session is reloaded.
	it("can fork from a message it just sent, without a reload", async () => {
		mockState.sendMessage.mockResolvedValue({ seq: 4 });

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		await act(async () => {
			await send.current("Try again");
		});

		const sent = findSent(latest.messages);
		expect(sent.anchorSeq).toBe(4);
		expect(isForkableMessage(sent)).toBe(true);
	});

	// The reply this message opens is drawn here from the echo's placeholder, and
	// no record ever reaches this tab to say when it began; the send's answer
	// does (docs/tool-call-ui.md#where-the-duration-comes-from).
	it("starts the reply it opened at the moment the server answered with", async () => {
		mockState.sendMessage.mockResolvedValue({ seq: 4, observedAt: 1234 });

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

		await act(async () => {
			await send.current("Try again");
		});

		const reply = latest.messages.at(-1) as AssistantMessage;
		expect(reply.role).toBe("assistant");
		expect(reply.openedAt).toBe(1234);
	});

	// Purely additive on the wire: a server that predates the seq answers with an
	// empty result. The message simply stays unaddressable, as every locally sent
	// one used to be — it must not fail the send or blank the fork icon's row.
	it("sends normally against a server that replies with no seq", async () => {
		mockState.sendMessage.mockResolvedValue({});

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

	// The sender is left out of the broadcast, so its own command is drawn from
	// what it typed until the reply brings the prompt the agent was actually sent.
	it("echoes a Pockode command as the command and fills in its prompt from the reply", async () => {
		let reply: (result: SentMessage) => void = () => {};
		mockState.sendMessage.mockReturnValueOnce(
			new Promise((resolve) => {
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
		await act(async () => {
			reply({
				seq: 5,
				expanded: {
					content: "Lead the work…",
					command: { name: "pockode-lead", args: "server's parse" },
				},
			});
			await sending;
		});

		expect(echo()).toMatchObject({
			content: "Lead the work…",
			command: { name: "pockode-lead", args: "server's parse" },
			anchorSeq: 5,
		});
	});

	// The server writes an answering message's body, so the echo starts empty
	// and takes the body from the reply — what a fork from it, or its preview,
	// would otherwise only see after a reload.
	it("fills an answer's echo with the body the server wrote", async () => {
		mockState.sendMessage.mockResolvedValueOnce({
			seq: 7,
			expanded: { content: "Answering:\n\nQ: Which?\nA: SQLite" },
		});
		const answering: QuestionAnswerRecord[] = [
			{
				request_id: "q1",
				question: "Which?",
				answers: ["SQLite"],
				answered_at: "2026-01-01T00:00:00Z",
			},
		];

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
		await act(async () => {
			await send.current("", answering);
		});

		expect(
			latest.messages.find((m) => m.role === "user" && m.answering),
		).toMatchObject({
			content: "Answering:\n\nQ: Which?\nA: SQLite",
			anchorSeq: 7,
		});
	});

	// The echo has only the browser's guess at each file; the reply has what the
	// server read from the stored bytes, and that is what stays on screen.
	it("sends files by id and fills their echo from the reply", async () => {
		mockState.sendMessage.mockResolvedValueOnce({
			seq: 3,
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
		});
		const file = { id: "abc.png", name: "shot.png", size: 5, mime: "" };

		const { latest, send } = renderSendProbe();
		await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
		await act(async () => {
			await send.current("", undefined, [file]);
		});

		expect(mockState.sendMessage).toHaveBeenCalledWith(
			expect.anything(),
			"",
			undefined,
			[{ id: "abc.png", name: "shot.png" }],
		);
		expect(
			latest.messages.find((m) => m.role === "user" && m.attachments),
		).toMatchObject({
			attachments: [{ mime: "image/png", width: 3, attachment_id: "abc.png" }],
			anchorSeq: 3,
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
		let reply: (result: SentMessage) => void = () => {};
		mockState.sendMessage.mockReturnValueOnce(
			new Promise((resolve) => {
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
			reply({ seq: 5 });
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
		// Replaced, not appended to.
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			parts: [{ type: "text", content: "Working\n\nand done" }],
		});
	});

	describe("a message it sent", () => {
		// The sender is left out of the update carrying its own message, so the
		// item is written from the reply — and the bubble the user watched
		// appear is the one that stays, under the same keys.
		it("keeps its bubbles when the transcript takes the message in", async () => {
			const sub = subscribeWith(() => page([turn({}, msg("before"))]));
			mockState.sendMessage.mockResolvedValue({
				seq: 50,
				itemId: 50,
				messageId: "m50",
			});

			const { latest, send } = renderSendProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));
			await act(async () => {
				await send.current("Try again");
			});
			const [echo, reply] = latest.messages.slice(-2);
			expect(reply).toMatchObject({ role: "assistant", status: "sending" });

			act(() =>
				sub.notify({
					type: "update",
					through_seq: 51,
					turns: [
						{
							turn: {
								turn_id: "t50",
								origin: "prompt",
								message_id: "m50",
								start_seq: 51,
								ended: false,
							},
						},
					],
					items: [
						{
							turn_id: "t50",
							item: {
								id: 50,
								kind: "message",
								seq: 50,
								last_seq: 50,
								message: { message_id: "m50", content: "Try again" },
							},
						},
					],
				}),
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
	});

	describe("a page's send", () => {
		const ACTION = { page: "p3", action: "approve", data: { id: "42" } };

		// Drawn from the action at once; the agent's text is the server's, and
		// the sender is left out of the broadcast that would carry it.
		it("is echoed as the action, then filled in from the reply", async () => {
			let reply: (result: SentHtmlAction) => void = () => {};
			mockState.sendHtmlAction.mockReturnValueOnce(
				new Promise((resolve) => {
					reply = resolve;
				}),
			);
			const { latest, send } = renderActionProbe();
			await waitFor(() => expect(latest.messages.length).toBeGreaterThan(0));

			let sending: Promise<void> = Promise.resolve();
			act(() => {
				sending = send.current(ACTION);
			});
			expect(mockState.sendHtmlAction).toHaveBeenCalledWith("s1", ACTION);
			expect(findAction(latest.messages)).toMatchObject({
				content: "",
				htmlAction: ACTION,
			});

			await act(async () => {
				reply({
					seq: 6,
					messageId: "m6",
					content: 'Page action "approve" from p3:\n{"id":"42"}',
					htmlAction: ACTION,
				});
				await sending;
			});
			expect(findAction(latest.messages)).toMatchObject({
				content: 'Page action "approve" from p3:\n{"id":"42"}',
				messageId: "m6",
				anchorSeq: 6,
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
