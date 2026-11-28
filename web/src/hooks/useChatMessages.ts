import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IDLE_TURN } from "../lib/activity";
import {
	type ChatAttachment,
	toAttachmentParams,
	toEchoFileBlocks,
} from "../lib/chatAttachments";
import {
	abandonOlderPage,
	addEcho,
	addOlderPage,
	applyToolDelta,
	applyUpdate,
	beginOlderPage,
	type ChatItems,
	createChatItems,
	failEcho,
	installNewestPage,
	pressAnswer,
	readServerClock,
	removeEcho,
	type SentRecord,
	settleEcho,
} from "../lib/chatItems";
import type { HtmlActionInput } from "../lib/rpc";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import {
	applyThinkingDelta,
	hasText,
	type LiveThinking,
	type TurnTail,
} from "../lib/thinking";
import {
	buildTranscript,
	createTranscriptCache,
	openAssistantIndex,
} from "../lib/transcript";
import { isTurnOpen } from "../lib/turnOverview";
import {
	type ConnectionStatus,
	isInvalidParamsRejection,
	isPermissionReviewerRejection,
	useWSStore,
} from "../lib/wsStore";
import type {
	ChatDelta,
	ChatPage,
	ChatStreams,
	ChatUpdate,
} from "../types/chatItems";
import type {
	ChatMessagesSubscribeResult,
	ChatNotification,
	Message,
	PermissionResponseParams,
	QuestionAnswerRecord,
	ReportedSessionMode,
	SessionMode,
	SessionTurn,
	UserMessage,
} from "../types/message";
import type { AgentType } from "../types/settings";
import { toAnswerParams } from "../utils/answerRecords";
import { isTypedByUser } from "../utils/messageSource";
import { parsePockodeCommand } from "../utils/pockodeCommand";
import { generateUUID } from "../utils/uuid";
import { useSubscription } from "./useSubscription";
import { useTurnOverview } from "./useTurnOverview";
import type { ViewedSession } from "./useViewedSession";

export type { ConnectionStatus } from "../lib/wsStore";

interface UseChatMessagesOptions {
	sessionId: string;
	/**
	 * Subscribe to the chat only once `sessionId` is known to belong to the
	 * worktree the connection is bound to. Subscribing earlier (mid worktree
	 * switch) targets a session the server can't see yet.
	 */
	enabled?: boolean;
	/**
	 * Set when the transcript is read out of another worktree instead of being
	 * subscribed to in the bound one (`useViewedSession`). Its newest page is
	 * installed the way a subscription's snapshot is, and earlier pages are
	 * asked for with `session_view.history` — identical items, identical
	 * paging, identical reply shape, so everything below this line is the same
	 * code. What changes is that there is no subscription, so nothing arrives
	 * after that page; and that its `detail` stands in for `sessionDetailStore`,
	 * which holds the bound worktree's open session and knows nothing about
	 * this one.
	 *
	 * Must be referentially stable across renders that do not change it; the
	 * hook hands back a memoized object.
	 */
	viewedSession?: ViewedSession | null;
}

interface UseChatMessagesReturn {
	messages: Message[];
	isLoadingHistory: boolean;
	/** Whether items older than `messages[0]` are still on the server. */
	hasMoreHistory: boolean;
	isLoadingMoreHistory: boolean;
	/** Why the last attempt at an earlier page failed; cleared by a retry. */
	historyError: string | null;
	/**
	 * Older pages pulled in so far. Bumped once per page, so a list can tell the
	 * commit that prepended history from the commits that merely appended to it.
	 * Read for two things: where the conversation begins is only said to a reader
	 * who has actually paged back, and a count that goes *down* is the one sign
	 * that a reconnect replaced the transcript (`useTranscriptScroll`).
	 */
	loadedHistoryPages: number;
	loadMoreHistory: () => Promise<void>;
	/**
	 * Whether a turn is open: Stop is on screen for exactly this, and the settings
	 * controls are locked for it (docs/lifecycle-ui.md §2.3). It is no longer what
	 * decides whether the composer can send — see `ChatPanel`.
	 */
	turnOpen: boolean;
	/**
	 * Whether the message the transcript ends on is one somebody typed — here or
	 * in another tab — that went into a turn already running, and so has no reply
	 * bubble of its own yet. Purely derived from the transcript's tail and the
	 * turn; it clears itself.
	 */
	isSendPending: boolean;
	/** What the session is doing, for the surfaces that need more than a boolean. */
	turn: SessionTurn;
	/** What the status line draws; see `TurnTail`. */
	tail: TurnTail;
	/**
	 * Thinking parts that settled while the user had the status line's panel
	 * open on them, so their rows open as they appear.
	 */
	openedThoughtIds: ReadonlySet<string>;
	/**
	 * The session's own settings, from `session.detail`. Until its first snapshot
	 * arrives they read as the placeholders below — no session has been described
	 * yet, and `isSessionDetailLoaded` is what says so.
	 */
	mode: ReportedSessionMode;
	agentType: AgentType;
	model: string;
	effort: string;
	isSessionActivated: boolean;
	/**
	 * Whether the four settings above describe this session rather than standing
	 * in for it. A control that names a value has to wait for this: naming the
	 * placeholder would show a model the session is not set to, and then correct
	 * itself a round trip later.
	 */
	isSessionDetailLoaded: boolean;
	status: ConnectionStatus;
	/**
	 * The last failed engine/mode switch, in the server's words. Switching is a
	 * deliberate user action whose only feedback is the control snapping back, so
	 * the reason has to reach the screen.
	 */
	settingError: string | null;
	clearSettingError: () => void;
	/**
	 * Sends a message, optionally answering posted questions. An answering send
	 * is all-or-nothing: the server validates every entry before delivering
	 * anything, and a refusal leaves the transcript exactly as it was — so this
	 * rethrows for those rather than reporting into the transcript, because the
	 * surface that has to hear about it is the sheet holding the drafts. A
	 * Pockode command (`/pockode-…`) the server refuses is taken back too, and
	 * rethrows for the same reason: the one who has to hear is the input it was
	 * typed into.
	 *
	 * `attachments` are files already uploaded to this session
	 * (`uploadChatAttachment`); the message may then have no text. A send
	 * carrying files that the server refuses — an id it does not have, an agent
	 * that cannot receive files — is taken back and rethrows like a refused
	 * command, so the composer can keep the files and say why.
	 */
	sendUserMessage: (
		content: string,
		answering?: QuestionAnswerRecord[],
		attachments?: ChatAttachment[],
	) => Promise<boolean>;
	/**
	 * Sends what a page sent (docs/tool-call-ui.md § The action message),
	 * echoed into the transcript as a typed message is — the sender is left
	 * out of the broadcast. Rejects on every failure, since the page that sent
	 * it is told the outcome: a refusal takes the echo back, as nothing was
	 * recorded; anything else leaves it with the failure under it, as a typed
	 * message's, because it may have been delivered.
	 */
	sendHtmlAction: (input: HtmlActionInput) => Promise<void>;
	interrupt: () => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	setMode: (mode: SessionMode) => Promise<void>;
	setAgentType: (agentType: AgentType) => Promise<void>;
	setModel: (model: string) => Promise<void>;
	setEffort: (effort: string) => Promise<void>;
	updatePermissionStatus: (
		requestId: string,
		status: "allowed" | "denied",
	) => void;
	/**
	 * Undoes the optimistic outcome on a permission card the server refused a
	 * decision for. Only permission cards reach it: an answer to a posted question
	 * travels as a message, and a refused one takes its whole echo with it (see
	 * `sendUserMessage`).
	 */
	resetPrompt: (requestId: string, status: "pending" | "expired") => void;
}

// Actions are stable references - get once at module level
const {
	sendMessage,
	sendHtmlAction,
	invalidateCommandCache,
	chatMessagesSubscribe,
	chatMessagesHistory,
	chatMessagesUnsubscribe,
	sessionViewHistory,
} = useWSStore.getState().actions;

type ToolDelta = NonNullable<ChatDelta["tool"]>;

/**
 * The most a call's un-flushed output may carry, in characters.
 *
 * The store keeps only the last lines of the accumulation anyway, so an older
 * chunk that has not reached it yet is already destined to be dropped — this is
 * only the ceiling for a tab that has been hidden long enough for "since the
 * last frame" to mean an hour of a build's stdout.
 */
const MAX_PENDING_OUTPUT = 64 * 1024;

/** Folds a call's delta onto the ones held for the next frame. */
function mergeToolDelta(
	pending: Map<string, ToolDelta>,
	delta: ToolDelta,
): void {
	const held = pending.get(delta.tool_use_id);
	if (!held || delta.replace) {
		pending.set(delta.tool_use_id, { ...delta });
		return;
	}
	const output = (held.output ?? "") + (delta.output ?? "");
	pending.set(delta.tool_use_id, {
		...held,
		...(delta.activity ? { activity: delta.activity } : {}),
		...(delta.subagent_progress
			? { subagent_progress: delta.subagent_progress }
			: {}),
		...(output
			? {
					output:
						output.length > MAX_PENDING_OUTPUT
							? output.slice(-MAX_PENDING_OUTPUT)
							: output,
				}
			: {}),
	});
}

function thinkingOf(streams: ChatStreams | undefined): LiveThinking | null {
	const thinking = streams?.thinking;
	if (!thinking) return null;
	return {
		content: thinking.content ?? "",
		fullReasoning: thinking.full_reasoning ?? "",
	};
}

/**
 * The thinking part an update settled the thinking stream into: the main
 * agent's newest thinking item among the ones it brought.
 */
function settledThoughtId(
	store: ChatItems,
	update: ChatUpdate,
): string | undefined {
	for (const { item, parent } of [...(update.items ?? [])].reverse()) {
		if (item.kind !== "thinking" || parent !== undefined) continue;
		if (item.thinking?.parent_tool_use_id) continue;
		if (item.id === undefined) continue;
		return store.partIds.get(item.id);
	}
	return undefined;
}

export function useChatMessages({
	sessionId,
	enabled = true,
	viewedSession,
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const isView = viewedSession != null;
	// Only read when `isView`; "" is a worktree — the main one — so the fallback
	// is a placeholder the type needs, not a default that means anything.
	const sourceWorktree = viewedSession?.worktree ?? "";
	// The items as the server sent them, and what was built from them. Mutated
	// only by the handlers below, each of which then commits a rebuild.
	const storeRef = useRef<ChatItems>(createChatItems());
	const cacheRef = useRef(createTranscriptCache());
	const [messages, setMessages] = useState<Message[]>([]);
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const [isLoadingHistory, setIsLoadingHistory] = useState(true);
	const [settingError, setSettingError] = useState<string | null>(null);
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [loadedHistoryPages, setLoadedHistoryPages] = useState(0);
	// Cursor for the next page back, straight from the server. Undefined means
	// the start of the session has been reached.
	const nextBeforeSeqRef = useRef<number | undefined>(undefined);
	// Identifies which transcript a page request was made against. A session
	// switch or a re-subscribe replaces the transcript wholesale, and a page still
	// in flight would otherwise be added to the one that took its place.
	const historyGenerationRef = useRef(0);
	const isLoadingMoreRef = useRef(false);

	const commit = useCallback(() => {
		setMessages(
			buildTranscript(storeRef.current, cacheRef.current, { live: !isView }),
		);
	}, [isView]);

	const status = useWSStore((state) => state.status);
	const actions = useWSStore((state) => state.actions);

	// The session's settings have one source: its own subscription, held by the
	// panel and read here out of the store. Neither the session list nor the chat
	// subscription carries them any more — both used to, and reading settings
	// from more than one of them is how a rejected model change came back as two
	// answers that disagreed.
	const liveDetail = useSessionDetailStore(selectSessionDetail(sessionId));
	const sessionDetail = isView ? viewedSession.detail : liveDetail;

	// One source for what the session is doing, and it is the live one: the
	// detail subscription reports every turn change as it happens.
	//
	// Idle until that first snapshot: a client that has not been told anything is
	// running is not entitled to draw a Stop button.
	//
	// A viewed transcript is idle for good. Whatever the session was doing when
	// it was read is already out of date — nothing is pushed here — and a turn
	// reported as open would arm a Stop this screen cannot deliver.
	const turn = isView ? IDLE_TURN : (sessionDetail?.turn ?? IDLE_TURN);
	// The turn's clock, carried over to this device's: the server's reading of
	// how long the turn had been open, taken back from when it arrived. Never
	// the server's own timestamp, which this clock need not agree with.
	const detailReceivedAt = useSessionDetailStore((s) => s.receivedAt);
	const turnOpenedAt =
		turn.open_elapsed_ms === undefined
			? undefined
			: detailReceivedAt - turn.open_elapsed_ms;

	// Placeholders for the round trip before the first snapshot: never another
	// session's values, because the selector above hands back nothing until the
	// detail held is this session's.
	const mode = sessionDetail?.mode ?? "default";
	const agentType = sessionDetail?.agent_type ?? "claude";
	const model = sessionDetail?.model ?? "";
	const effort = sessionDetail?.effort ?? "";
	// The server refuses to change agent type once the agent has answered here,
	// and says so through this flag. The transcript is not a substitute for it: a
	// first turn that failed before the agent said anything leaves messages behind
	// in a session that never started, and that is exactly when switching agents
	// is the only way out.
	const isSessionActivated = sessionDetail?.activated ?? false;

	// What the calls in flight have streamed since the last animation frame. A
	// chatty build's output arrives faster than the screen refreshes, and
	// applying each delta would re-render the transcript per line of stdout.
	//
	// Held merged, one entry per call, rather than as a queue: it is the deltas'
	// own semantics — the activity is a latest value, the output accumulates —
	// and it is what bounds this while nothing is flushing it.
	// `requestAnimationFrame` does not fire in a hidden tab, and a phone spends
	// most of a long build with the browser in the background; a queue would
	// grow with the output, a merge grows with the number of live calls.
	const pendingToolDeltasRef = useRef(new Map<string, ToolDelta>());
	const toolFrameRef = useRef<number | undefined>(undefined);

	const flushToolDeltas = useCallback(() => {
		toolFrameRef.current = undefined;
		const pending = pendingToolDeltasRef.current;
		if (pending.size === 0) return;
		pendingToolDeltasRef.current = new Map();
		for (const [toolUseId, delta] of pending) {
			applyToolDelta(storeRef.current, toolUseId, delta);
		}
		commit();
	}, [commit]);

	// Deltas held for the next frame are applied before anything that comes
	// after them, so an update ending a stream is never followed by its output.
	const flushToolDeltasNow = useCallback(() => {
		if (toolFrameRef.current !== undefined) {
			cancelAnimationFrame(toolFrameRef.current);
			toolFrameRef.current = undefined;
		}
		const pending = pendingToolDeltasRef.current;
		pendingToolDeltasRef.current = new Map();
		for (const [toolUseId, delta] of pending) {
			applyToolDelta(storeRef.current, toolUseId, delta);
		}
	}, []);

	useEffect(() => {
		return () => {
			if (toolFrameRef.current !== undefined) {
				cancelAnimationFrame(toolFrameRef.current);
			}
		};
	}, []);

	// What the main agent is thinking right now. Not a part of the transcript:
	// it is never recorded, and it ends with the item that is. Coalesced per
	// frame like tool deltas, for the same two reasons — deltas outrun the
	// screen, and a hidden tab flushes nothing, so they are held folded rather
	// than queued.
	const [liveThinking, setLiveThinking] = useState<LiveThinking | null>(null);
	const liveThinkingRef = useRef(liveThinking);
	liveThinkingRef.current = liveThinking;
	// What the next frame applies: deltas to fold on, or — after a `replace` —
	// the whole thinking so far.
	const pendingThinkingRef = useRef<{
		thinking: LiveThinking;
		replace: boolean;
	} | null>(null);
	const thinkingFrameRef = useRef<number | undefined>(undefined);
	// Set when a thinking settles under the open panel: its row opens with it.
	const [openedThoughtIds, setOpenedThoughtIds] = useState<ReadonlySet<string>>(
		new Set(),
	);

	const flushThinking = useCallback(() => {
		thinkingFrameRef.current = undefined;
		const pending = pendingThinkingRef.current;
		if (!pending) return;
		pendingThinkingRef.current = null;
		setLiveThinking((prev) =>
			prev && !pending.replace
				? applyThinkingDelta(prev, pending.thinking)
				: pending.thinking,
		);
	}, []);

	// Deltas held for the next frame belong to the thinking being ended, and a
	// flush after this would bring it back.
	const endThinking = useCallback(() => {
		if (thinkingFrameRef.current !== undefined) {
			cancelAnimationFrame(thinkingFrameRef.current);
			thinkingFrameRef.current = undefined;
		}
		pendingThinkingRef.current = null;
		setLiveThinking(null);
	}, []);

	useEffect(() => {
		return () => {
			if (thinkingFrameRef.current !== undefined) {
				cancelAnimationFrame(thinkingFrameRef.current);
			}
		};
	}, []);

	// A turn that is over thinks no more, however it ended.
	useEffect(() => {
		if (!turn.open) endThinking();
	}, [turn.open, endThinking]);

	// Whether a turn is open, and the optimistic half is load-bearing: between the
	// user pressing send and the server reporting `running` there is a round trip,
	// and a surface watching only the turn would leave them without Stop for the
	// length of it (docs/lifecycle-ui.md §2.3). `MessageList` asks the same
	// question for the step windows, so the rule is `isTurnOpen`'s alone.
	const openIndex = openAssistantIndex(messages);
	const open = openIndex >= 0 ? messages[openIndex] : undefined;
	const turnOpen = isTurnOpen(messages, turn.phase);
	// Its fields go into the memo one by one, so it depends on the id rather
	// than on `messages`: the tail is a context every bubble's slot reads, and a
	// new value per streamed record would re-render every one of them.
	const {
		plan,
		agents,
		panel,
		overviewMessageId: overviewId,
	} = useTurnOverview(
		messages,
		turnOpen,
		sessionId,
		// As `TurnTail` draws it: in the open bubble, while running.
		open !== undefined &&
			turn.phase === "running" &&
			liveThinking !== null &&
			hasText(liveThinking),
	);
	const panelOpenRef = useRef(panel.expanded);
	panelOpenRef.current = panel.expanded;
	const tail = useMemo<TurnTail>(
		() => ({
			phase: turn.phase,
			openedAt: turnOpenedAt,
			thinking: liveThinking,
			overviewMessageId: overviewId,
			plan,
			agents,
			panel,
		}),
		[turn.phase, turnOpenedAt, liveThinking, overviewId, plan, agents, panel],
	);

	// Set once the subscription below exists; the notification handler is
	// declared before it.
	const resubscribeRef = useRef<() => Promise<void>>(async () => {});

	const handleUpdate = useCallback(
		(update: ChatUpdate) => {
			flushToolDeltasNow();
			const store = storeRef.current;
			if (update.streams_ended?.thinking) {
				// Its section was showing only if it had text.
				const thinking = liveThinkingRef.current;
				if (panelOpenRef.current && thinking && hasText(thinking)) {
					applyUpdate(store, update, new Date());
					// In the same render as the row, so it is never drawn closed.
					const id = settledThoughtId(store, update);
					if (id) setOpenedThoughtIds((prev) => new Set(prev).add(id));
					endThinking();
					commit();
					return;
				}
				endThinking();
			}
			applyUpdate(store, update, new Date());
			commit();
		},
		[commit, endThinking, flushToolDeltasNow],
	);

	const handleNotification = useCallback(
		(notification: ChatNotification) => {
			// The server could not tell this subscription something and will send
			// nothing more on it, so the transcript is rebuilt exactly as after a
			// reconnect: a fresh subscription, whose snapshot replaces it wholesale.
			if (notification.type === "resync") {
				void resubscribeRef.current();
				return;
			}
			if (notification.type === "update") {
				handleUpdate(notification);
				return;
			}
			if (notification.thinking) {
				const { replace, ...stream } = notification.thinking;
				const thinking = thinkingOf({ thinking: stream });
				if (thinking) {
					const held = pendingThinkingRef.current;
					pendingThinkingRef.current =
						held && !replace
							? {
									thinking: applyThinkingDelta(held.thinking, thinking),
									replace: held.replace,
								}
							: {
									thinking,
									replace: replace === true,
								};
					if (thinkingFrameRef.current === undefined) {
						thinkingFrameRef.current = requestAnimationFrame(flushThinking);
					}
				}
			}
			if (notification.tool) {
				mergeToolDelta(pendingToolDeltasRef.current, notification.tool);
				if (toolFrameRef.current === undefined) {
					toolFrameRef.current = requestAnimationFrame(flushToolDeltas);
				}
			}
		},
		[flushThinking, flushToolDeltas, handleUpdate],
	);

	// Reset when the session changes. During render rather than in an effect: an
	// effect runs after the render that already carries the new session id has
	// been committed, so the previous session's messages would reach the DOM for
	// a frame as if they belonged to the session just opened. React re-runs this
	// component before committing anything, so no such frame exists.
	const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
	if (renderedSessionId !== sessionId) {
		setRenderedSessionId(sessionId);
		storeRef.current = createChatItems();
		cacheRef.current = createTranscriptCache();
		setMessages([]);
		setIsLoadingHistory(true);
		setSettingError(null);
		setHasMoreHistory(false);
		setIsLoadingMoreHistory(false);
		setHistoryError(null);
		setLoadedHistoryPages(0);
		nextBeforeSeqRef.current = undefined;
		isLoadingMoreRef.current = false;
		historyGenerationRef.current++;
		// Progress held for the next frame belongs to the session being left.
		pendingToolDeltasRef.current.clear();
		pendingThinkingRef.current = null;
		setLiveThinking(null);
		setOpenedThoughtIds(new Set());
	}

	// The transcript's own subscription, opened through the common layer like
	// every other one: an update sent between the subscription being registered
	// and its reply reaching this client is held by `useSubscription` until the
	// page is in, and replayed after — the store skips what the page already
	// holds (`through_seq`).
	//
	// Loading state is managed by the initial value and the reset above, so
	// re-subscribing on reconnect won't flash the spinner. It also stays true for
	// as long as `enabled` is false, which is what makes "waiting for the session
	// to resolve" and "waiting for its history" a single continuous wait for
	// callers timing a loading indicator against it.
	const subscribe = useCallback(
		(onNotification: (notification: ChatNotification) => void) =>
			chatMessagesSubscribe(sessionId, onNotification),
		[sessionId],
	);

	// `receivedAt` is when the page reached this client, which its clock reading
	// is taken against: a page installed from a cache arrived before now.
	const installPage = useCallback(
		(page: ChatPage, streams: ChatStreams | undefined, receivedAt: number) => {
			// Subscribing hands back the newest page only, and a re-subscribe
			// hands it back again: pages paged in before a reconnect are gone, so
			// the paging state starts over with them.
			historyGenerationRef.current++;
			// Both halves of "a page is on its way", or the flag left standing
			// would be read as one: the request this generation bump discards
			// skips its own reset, having learnt it no longer speaks for this
			// transcript.
			isLoadingMoreRef.current = false;
			setIsLoadingMoreHistory(false);
			// Keyed on the cursor rather than on `has_more`: the cursor is what
			// an earlier page is actually asked for with, so the history reserve
			// can never be left offering a page there is no way to request.
			setHasMoreHistory(page.next_before_seq !== undefined);
			setLoadedHistoryPages(0);
			setHistoryError(null);
			nextBeforeSeqRef.current = page.next_before_seq;
			// Deltas held for the transcript being replaced: the snapshot's
			// streams already include them.
			pendingToolDeltasRef.current.clear();
			endThinking();
			setLiveThinking(thinkingOf(streams));
			installNewestPage(
				storeRef.current,
				page,
				streams,
				readServerClock(page, receivedAt),
			);
			commit();
			setIsLoadingHistory(false);
		},
		[commit, endThinking],
	);

	const handleSubscribed = useCallback(
		(initial: ChatMessagesSubscribeResult) =>
			installPage(initial, initial.streams, Date.now()),
		[installPage],
	);

	const handleSubscribeError = useCallback((err: unknown) => {
		console.error("Failed to subscribe to chat messages:", err);
		// The wait is over either way: leaving the spinner up would promise a
		// transcript that is not coming.
		setIsLoadingHistory(false);
	}, []);

	const { refresh: resubscribe } = useSubscription<
		ChatNotification,
		ChatMessagesSubscribeResult
	>(subscribe, chatMessagesUnsubscribe, handleNotification, {
		enabled: enabled && !isView,
		// A session belongs to its worktree, so switching does end this
		// subscription server-side — but it ends the session with it, and
		// `enabled` has already gone false by then. Resubscribing on switch
		// would only ask the new worktree about a session id it has never heard
		// of. See useSessionDetailSubscription, which is gated the same way.
		resubscribeOnWorktreeChange: false,
		onSubscribed: handleSubscribed,
		onError: handleSubscribeError,
	});
	resubscribeRef.current = resubscribe;

	// The viewed transcript's newest page, installed the way a subscription's
	// snapshot is. Nothing ever continues it, so it has no streams.
	useEffect(() => {
		if (!viewedSession) return;
		// Both reads, not just the page: the two go out together, so waiting for
		// the slower one costs nothing, and mounting the transcript before the
		// metadata lands would draw it as the wrong agent's for a frame — the
		// same one continuous wait the live path makes of resolving a session and
		// loading its history.
		if (!viewedSession.isSettled) return;
		if (viewedSession.page) {
			installPage(viewedSession.page, undefined, viewedSession.pageReceivedAt);
			return;
		}
		// The read answered without a page. The wait is over either way — leaving
		// the spinner up would promise a transcript that is not coming; the reason
		// reaches the screen through `viewedSession` itself.
		setIsLoadingHistory(false);
	}, [viewedSession, installPage]);

	const loadMoreHistory = useCallback(async () => {
		const beforeSeq = nextBeforeSeqRef.current;
		if (isLoadingMoreRef.current || beforeSeq === undefined) return;

		const generation = historyGenerationRef.current;
		isLoadingMoreRef.current = true;
		setIsLoadingMoreHistory(true);
		setHistoryError(null);
		beginOlderPage(storeRef.current);
		try {
			const page = isView
				? await sessionViewHistory(sourceWorktree, sessionId, beforeSeq)
				: await chatMessagesHistory(sessionId, beforeSeq);
			if (historyGenerationRef.current !== generation) return;

			addOlderPage(storeRef.current, page, readServerClock(page));
			commit();
			nextBeforeSeqRef.current = page.next_before_seq;
			setHasMoreHistory(page.next_before_seq !== undefined);
			setLoadedHistoryPages((n) => n + 1);
		} catch (error) {
			if (historyGenerationRef.current !== generation) return;
			abandonOlderPage(storeRef.current);
			// Silence here would read as "this is the start of the conversation",
			// which is the one thing the user must not conclude from a failure.
			const reason =
				error instanceof Error && error.message
					? error.message
					: "Unknown error";
			setHistoryError(`Failed to load earlier messages: ${reason}`);
		} finally {
			// Only for the transcript this request belongs to: a newer generation
			// owns the flag now, and may already have a page of its own in flight.
			if (historyGenerationRef.current === generation) {
				isLoadingMoreRef.current = false;
				setIsLoadingMoreHistory(false);
			}
		}
	}, [sessionId, isView, sourceWorktree, commit]);

	/**
	 * The one path a message sent from this screen takes: echoed at once — with
	 * a placeholder for the reply when it opens a turn — then filled in from the
	 * server's reply, or taken back, or left with the failure under it. Typed
	 * messages and page actions differ only in what they send and what the
	 * reply fills in.
	 */
	const deliverEcho = useCallback(
		async (
			echo: UserMessage,
			send: () => Promise<SentRecord>,
			{
				takeBack,
				rethrow,
			}: {
				/** Whether a failure means nothing was recorded, so the echo goes. */
				takeBack: (error: unknown) => boolean;
				/** Rethrow a failure that was reported into the transcript too. */
				rethrow: boolean;
			},
		): Promise<boolean> => {
			// A message sent into a running turn is drawn under the reply still
			// being written, and gets no placeholder of its own: the bubble for
			// what the agent writes after reading it opens where it reads it. One
			// sent to an idle agent opens a turn, and its reply is drawn at once.
			const opensTurn = openAssistantIndex(messagesRef.current) < 0;
			addEcho(storeRef.current, {
				message: echo,
				awaitingReply: true,
				...(opensTurn ? { replyId: generateUUID() } : {}),
			});
			commit();

			try {
				// The sender is left out of the update carrying its own message,
				// so the reply is its one copy of what the record holds — what the
				// agent was actually sent, the files as stored, the record's id
				// and seq, and the item later updates name it by.
				const sent = await send();
				settleEcho(storeRef.current, echo.id, sent);
				commit();
				return true;
			} catch (error) {
				console.error("Failed to send message:", error);
				if (takeBack(error)) {
					removeEcho(storeRef.current, echo.id);
					commit();
					throw error;
				}
				// The server's reason is what tells a missing CLI apart from a
				// dropped connection; without it every failure reads the same.
				// Said under the message it failed to deliver: it may have been
				// delivered, and silence would leave it looking sent.
				const reason =
					error instanceof Error && error.message
						? error.message
						: "Unknown error";
				failEcho(
					storeRef.current,
					echo.id,
					`Failed to send message: ${reason}`,
				);
				commit();
				if (rethrow) throw error;
				return false;
			}
		},
		[commit],
	);

	const sendUserMessageHandler = useCallback(
		async (
			content: string,
			answering?: QuestionAnswerRecord[],
			attachments?: ChatAttachment[],
		): Promise<boolean> => {
			// Normalised once, so "present" and "non-empty" cannot come apart: an
			// empty list would otherwise echo a bubble drawn from no answers, send
			// no `answering`, and take the wrong branch on failure.
			const answers = answering?.length ? answering : undefined;
			const files = attachments?.length ? attachments : undefined;
			// Drawn as the command row from the first frame rather than as a bubble
			// that turns into one: the prompt it stands for is the server's to
			// expand, and arrives with the reply.
			const command = parsePockodeCommand(content) ?? undefined;

			const echo: UserMessage = {
				id: generateUUID(),
				role: "user",
				content: command ? "" : content,
				status: "complete",
				createdAt: new Date(),
				...(command ? { command } : {}),
				// Echoed with the bubble so an answer draws as answers rather than
				// as the flattened text the agent reads.
				...(answers ? { answering: answers } : {}),
				...(files ? { attachments: toEchoFileBlocks(files) } : {}),
			};

			const sent = await deliverEcho(
				echo,
				async () => {
					const {
						seq,
						itemId,
						messageId,
						expanded,
						attachments: described,
						observedAt,
					} = await sendMessage(
						sessionId,
						content,
						answers && toAnswerParams(answers),
						// Only when there are any, so a message without files is sent with
						// exactly the arguments it always was.
						...(files ? [toAttachmentParams(files)] : []),
					);
					// A command's parse and prompt, or the body written from the
					// answers; the files with the type the stored bytes are, where the
					// echo had only the browser's guess.
					return {
						seq,
						itemId,
						observedAt,
						update: {
							...expanded,
							...(described ? { attachments: described } : {}),
							...(messageId ? { messageId } : {}),
							...(seq !== undefined ? { anchorSeq: seq } : {}),
						},
					};
				},
				{
					// An answering send is refused whole — nothing was written, nothing
					// was delivered, and the questions are all still open — so the echo
					// is taken back out rather than left looking sent with a failure
					// pinned under it. The sheet is where the reason belongs: it holds
					// the drafts, and it is what the user is looking at.
					//
					// A command the server refused (an unknown name, a worktree with no
					// branch, or a send refused as any message's would be) is gone the
					// same way, and the caller restores what was typed and says why.
					// Only a refusal: a timeout or a dropped socket may have been
					// delivered, and handing the draft back would invite running the
					// command twice — that takes the ordinary path. A message carrying
					// files is taken back on a refusal for the same reason: the files
					// are the composer's to keep, and an agent that cannot receive them
					// is said so there.
					// A reviewer refusing a person is no failure of this message: the
					// screen turns read-only and the draft goes back to the input
					// store (docs/unattended-mode-ui.md §5).
					takeBack: (error) =>
						answers !== undefined ||
						isPermissionReviewerRejection(error) ||
						((command !== undefined || files !== undefined) &&
							isInvalidParamsRejection(error)),
					rethrow: false,
				},
			);
			// Not at click time: the server records a slash command's use only
			// once the send has gone through, and a list fetched in between would
			// be cached without it.
			if (sent && content.startsWith("/")) invalidateCommandCache();
			return sent;
		},
		[sessionId, deliverEcho],
	);

	const sendHtmlActionHandler = useCallback(
		async (input: HtmlActionInput): Promise<void> => {
			// Drawn from `htmlAction` from the first frame; `content` is the
			// agent's text, which only the server writes.
			const echo: UserMessage = {
				id: generateUUID(),
				role: "user",
				content: "",
				status: "complete",
				createdAt: new Date(),
				htmlAction: {
					page: input.page,
					action: input.action,
					data: input.data === undefined ? {} : input.data,
				},
			};
			await deliverEcho(
				echo,
				async () => {
					const { seq, itemId, messageId, content, htmlAction, observedAt } =
						await sendHtmlAction(sessionId, input);
					return {
						seq,
						itemId,
						observedAt,
						update: {
							...(content !== undefined ? { content } : {}),
							...(htmlAction ? { htmlAction } : {}),
							...(messageId ? { messageId } : {}),
							...(seq !== undefined ? { anchorSeq: seq } : {}),
						},
					};
				},
				// A refusal recorded nothing, so its echo goes; the page that sent
				// it is told either way, and says it under the card.
				{ takeBack: isInvalidParamsRejection, rethrow: true },
			);
		},
		[sessionId, deliverEcho],
	);

	// A press on a permission card is drawn at once; the server's answer
	// replaces it when the update recording it arrives.
	const updatePermissionStatus = useCallback(
		(requestId: string, newStatus: "allowed" | "denied") => {
			pressAnswer(storeRef.current, requestId, newStatus);
			commit();
		},
		[commit],
	);

	const resetPrompt = useCallback(
		(requestId: string, status: "pending" | "expired") => {
			pressAnswer(storeRef.current, requestId, status);
			commit();
		},
		[commit],
	);

	// Whether the message the transcript ends on went into a turn that was already
	// running and is still unread. Derived, never recorded: the record says what
	// was typed at that moment and cannot also carry whether the agent has picked
	// it up (AGENTS.md, "events are events, state is state"). Reading it back out
	// of the transcript costs nothing and is always current: the turn ending
	// retires it, and so does the read point, which puts a bubble under this
	// message as soon as the agent reaches it.
	//
	// Any tab's message counts, because any tab's message reaches the same CLI and
	// steers the same turn. Kickoff, restart and auto-continue arrive as
	// `role: "user"` too, and so does another agent's answer, but nobody typed
	// those, so they get no receipt.
	const last = messages[messages.length - 1];
	const isSendPending = turnOpen && last !== undefined && isTypedByUser(last);

	// One path for every session setting. Nothing is applied here: the new value
	// reaches the screen through the session detail subscription, so a rejected
	// change leaves the control showing what the session is still set to, with the
	// server's reason recorded for the UI to show.
	const applySetting = useCallback(
		async (what: string, send: () => Promise<void>) => {
			try {
				await send();
				setSettingError(null);
			} catch (error) {
				const reason =
					error instanceof Error && error.message
						? error.message
						: "Unknown error";
				setSettingError(`Failed to change ${what}: ${reason}`);
				throw error;
			}
		},
		[],
	);

	const setMode = useCallback(
		(newMode: SessionMode) =>
			applySetting("mode", () => actions.setSessionMode(sessionId, newMode)),
		[applySetting, actions, sessionId],
	);

	const setAgentType = useCallback(
		(newAgentType: AgentType) =>
			applySetting("agent", () =>
				actions.setSessionAgentType(sessionId, newAgentType),
			),
		[applySetting, actions, sessionId],
	);

	const setModel = useCallback(
		(newModel: string) =>
			applySetting("model", () => actions.setSessionModel(sessionId, newModel)),
		[applySetting, actions, sessionId],
	);

	const setEffort = useCallback(
		(newEffort: string) =>
			applySetting("effort", () =>
				actions.setSessionEffort(sessionId, newEffort),
			),
		[applySetting, actions, sessionId],
	);

	const clearSettingError = useCallback(() => setSettingError(null), []);

	return {
		messages,
		isLoadingHistory,
		hasMoreHistory,
		isLoadingMoreHistory,
		historyError,
		loadedHistoryPages,
		loadMoreHistory,
		turnOpen,
		isSendPending,
		turn,
		tail,
		openedThoughtIds,
		mode,
		agentType,
		model,
		effort,
		isSessionActivated,
		isSessionDetailLoaded: sessionDetail !== null,
		status,
		settingError,
		clearSettingError,
		sendUserMessage: sendUserMessageHandler,
		sendHtmlAction: sendHtmlActionHandler,
		interrupt: useCallback(
			() => actions.interrupt(sessionId),
			[actions, sessionId],
		),
		permissionResponse: actions.permissionResponse,
		setMode,
		setAgentType,
		setModel,
		setEffort,
		updatePermissionStatus,
		resetPrompt,
	};
}
