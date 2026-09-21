import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_TURN } from "../lib/activity";
import {
	appendUserMessage,
	applyAnswering,
	applyServerEvent,
	applyToolActivitySnapshot,
	isBackReference,
	isTurnTerminal,
	type NormalizedEvent,
	normalizeEvent,
	openAssistantIndex,
	prependHistoryPage,
	readHistorySeq,
	replayHistory,
	resetPromptRequest,
	settleAgainstTurn,
	stampMessageAnchorSeq,
	updatePermissionRequestStatus,
} from "../lib/messageReducer";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import { type ConnectionStatus, useWSStore } from "../lib/wsStore";
import type {
	AssistantMessage,
	ChatMessagesSubscribeResult,
	HistorySeq,
	Message,
	PermissionResponseParams,
	QuestionAnswerRecord,
	ServerNotification,
	SessionMode,
	SessionTurn,
	UserMessage,
} from "../types/message";
import type { AgentType } from "../types/settings";
import { toAnswerParams } from "../utils/answerMessage";
import { isTypedByUser } from "../utils/messageSource";
import { generateUUID } from "../utils/uuid";
import { useSubscription } from "./useSubscription";

export type { ConnectionStatus } from "../lib/wsStore";

interface UseChatMessagesOptions {
	sessionId: string;
	/**
	 * Subscribe to the chat only once `sessionId` is known to belong to the
	 * worktree the connection is bound to. Subscribing earlier (mid worktree
	 * switch) targets a session the server can't see yet.
	 */
	enabled?: boolean;
}

interface UseChatMessagesReturn {
	messages: Message[];
	isLoadingHistory: boolean;
	/** Whether records older than `messages[0]` are still on the server. */
	hasMoreHistory: boolean;
	isLoadingMoreHistory: boolean;
	/** Why the last attempt at an earlier page failed; cleared by a retry. */
	historyError: string | null;
	/**
	 * Older pages pulled in so far. Bumped once per page, so a list can tell the
	 * commit that prepended history from the commits that merely appended to it —
	 * the difference between restoring the scroll position and following the tail.
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
	/**
	 * The session's own settings, from `session.detail`. Until its first snapshot
	 * arrives they read as the placeholders below — no session has been described
	 * yet, and `isSessionDetailLoaded` is what says so.
	 */
	mode: SessionMode;
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
	 * surface that has to hear about it is the sheet holding the drafts.
	 */
	sendUserMessage: (
		content: string,
		answering?: QuestionAnswerRecord[],
	) => Promise<boolean>;
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
	chatMessagesSubscribe,
	chatMessagesHistory,
	chatMessagesUnsubscribe,
} = useWSStore.getState().actions;

/** One call's progress since the last frame, in the records' own semantics. */
interface PendingActivity {
	/** The newest one: each report replaces the last. */
	activity?: string;
	/** Every chunk since the last frame, in order. */
	outputDelta?: string;
}

/**
 * The most a call's un-flushed output may carry, in characters.
 *
 * The reducer keeps only the last lines of the accumulation anyway, so an older
 * chunk that has not reached it yet is already destined to be dropped — this is
 * only the ceiling for a tab that has been hidden long enough for "since the
 * last frame" to mean an hour of a build's stdout.
 */
const MAX_PENDING_OUTPUT = 64 * 1024;

function mergeActivity(
	pending: Map<string, PendingActivity>,
	event: Extract<NormalizedEvent, { type: "tool_activity" }>,
): void {
	const current = pending.get(event.toolUseId) ?? {};
	if (event.activity) current.activity = event.activity;
	if (event.outputDelta) {
		const combined = (current.outputDelta ?? "") + event.outputDelta;
		current.outputDelta =
			combined.length > MAX_PENDING_OUTPUT
				? combined.slice(-MAX_PENDING_OUTPUT)
				: combined;
	}
	pending.set(event.toolUseId, current);
}

/**
 * The record a page opens on, when all it does is end a turn. The turn it ended
 * is the one the page below trails off on, so this page cannot use it — only the
 * page below can, once it is loaded.
 *
 * Only the first record is looked at. A terminal record behind another one has
 * no turn of its own to end either — replaying the whole history unbroken drops
 * it just the same — except for `process_ended`, which reaches every page as a
 * back-reference anyway.
 */
function leadingTurnTerminal(history: unknown[]): unknown {
	const first = history[0];
	return isTurnTerminal(first) ? first : undefined;
}

/**
 * The newest record's seq in a history page, or undefined if the page addresses
 * none. Records are appended in seq order, so this is the last one that has a
 * seq at all — a page can end on records that were never persisted.
 */
function newestSeq(history: unknown[]): HistorySeq | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const seq = readHistorySeq(history[i]);
		if (seq !== undefined) return seq;
	}
	return undefined;
}

export function useChatMessages({
	sessionId,
	enabled = true,
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(true);
	const [settingError, setSettingError] = useState<string | null>(null);
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [loadedHistoryPages, setLoadedHistoryPages] = useState(0);
	// Cursor for the next page back, straight from the server: a record it could
	// not address carries no seq, so one derived here would eventually name
	// nothing. Undefined means the start of the session has been reached.
	const nextBeforeSeqRef = useRef<HistorySeq | undefined>(undefined);
	// Every back-reference record seen so far, oldest first, so an older page can
	// be caught up on the answers the loaded pages already hold.
	const backReferencesRef = useRef<unknown[]>([]);
	// The oldest loaded record, when it is one that only ends a turn. Replaying
	// its own page dropped it — the turn it ended is below the page, not in it —
	// so it is held for the page that turn is on. See `prependHistoryPage`.
	const boundaryTerminalRef = useRef<unknown>(undefined);
	// What the session was doing at subscribe time, for the older pages. A
	// transcript cut short by a restart says nothing about its own end, so that
	// fact reaches an older page from here rather than through the
	// back-references; a process that ends while connected broadcasts the record
	// and travels with them.
	const subscribedTurnRef = useRef<SessionTurn>(IDLE_TURN);
	// The newest record the loaded page holds. A live notification for a record
	// the page already carries is the one thing the subscription can deliver
	// twice: the server registers the subscription before it reads the history,
	// so a record committed in between is in both. See `handleNotification`.
	const newestHistorySeqRef = useRef<HistorySeq | undefined>(undefined);
	// Identifies which transcript a page request was made against. A session
	// switch or a re-subscribe replaces the transcript wholesale, and a page still
	// in flight would otherwise be spliced into the one that took its place.
	const historyGenerationRef = useRef(0);
	const isLoadingMoreRef = useRef(false);

	const status = useWSStore((state) => state.status);
	const actions = useWSStore((state) => state.actions);

	// The session's settings have one source: its own subscription, held by the
	// panel and read here out of the store. Neither the session list nor the chat
	// subscription carries them any more — both used to, and reading settings
	// from more than one of them is how a rejected model change came back as two
	// answers that disagreed.
	const sessionDetail = useSessionDetailStore(selectSessionDetail(sessionId));

	// One source for what the session is doing, and it is the live one: the
	// detail subscription reports every turn change as it happens. The chat
	// subscription's own copy is used once, to settle the page it came with — a
	// second live copy of one fact would arrive in an order neither side controls.
	//
	// Idle until that first snapshot: a client that has not been told anything is
	// running is not entitled to draw a Stop button.
	const turn = sessionDetail?.turn ?? IDLE_TURN;

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

	// What the calls in flight have reported since the last animation frame. A
	// chatty build's `output_delta` arrives faster than the screen refreshes, and
	// applying each one would re-render the transcript per line of stdout.
	//
	// Held merged, one entry per call, rather than as a queue of records: it is
	// the records' own semantics — the activity is a latest value, the deltas
	// accumulate — and it is what bounds this while nothing is flushing it.
	// `requestAnimationFrame` does not fire in a hidden tab, and a phone spends
	// most of a long build with the browser in the background; a queue would
	// grow with the output, a merge grows with the number of live calls.
	const pendingActivityRef = useRef(new Map<string, PendingActivity>());
	const activityFrameRef = useRef<number | undefined>(undefined);

	const flushActivity = useCallback(() => {
		activityFrameRef.current = undefined;
		const pending = pendingActivityRef.current;
		if (pending.size === 0) return;
		pendingActivityRef.current = new Map();
		setMessages((prev) =>
			[...pending].reduce(
				(acc, [toolUseId, merged]) =>
					applyServerEvent(acc, {
						type: "tool_activity",
						toolUseId,
						...merged,
					}),
				prev,
			),
		);
	}, []);

	useEffect(() => {
		return () => {
			if (activityFrameRef.current !== undefined) {
				cancelAnimationFrame(activityFrameRef.current);
			}
		};
	}, []);

	const handleNotification = useCallback(
		(notification: ServerNotification) => {
			const seq = readHistorySeq(notification);
			// Already on screen: this record came back in the history page too, and
			// applying it again would put a second copy of the message in the
			// transcript. Only a record the page actually reaches is skipped — seqs
			// grow with the session, so anything newer is a record the page never had.
			// A record with no seq is not addressable at all (never persisted, or a
			// server too old to say), so it cannot be matched against the page and is
			// applied — the duplicate the whole subscription has always tolerated.
			if (
				seq !== undefined &&
				newestHistorySeqRef.current !== undefined &&
				seq <= newestHistorySeqRef.current
			) {
				return;
			}

			if (isBackReference(notification)) {
				backReferencesRef.current.push(notification);
			}
			const event = normalizeEvent(notification);
			if (event.type === "tool_activity") {
				mergeActivity(pendingActivityRef.current, event);
				if (activityFrameRef.current === undefined) {
					activityFrameRef.current = requestAnimationFrame(flushActivity);
				}
				return;
			}
			// Live, so a call this client watched start may draw a stopwatch — a
			// replayed one has no honest clock to draw from.
			setMessages((prev) => applyServerEvent(prev, event, seq, { live: true }));
		},
		[flushActivity],
	);

	// Reset when the session changes. During render rather than in an effect: an
	// effect runs after the render that already carries the new session id has
	// been committed, so the previous session's messages would reach the DOM for
	// a frame as if they belonged to the session just opened. React re-runs this
	// component before committing anything, so no such frame exists.
	const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
	if (renderedSessionId !== sessionId) {
		setRenderedSessionId(sessionId);
		setMessages([]);
		setIsLoadingHistory(true);
		setSettingError(null);
		setHasMoreHistory(false);
		setIsLoadingMoreHistory(false);
		setHistoryError(null);
		setLoadedHistoryPages(0);
		nextBeforeSeqRef.current = undefined;
		backReferencesRef.current = [];
		boundaryTerminalRef.current = undefined;
		newestHistorySeqRef.current = undefined;
		subscribedTurnRef.current = IDLE_TURN;
		isLoadingMoreRef.current = false;
		historyGenerationRef.current++;
		// Progress held for the next frame belongs to the session being left.
		pendingActivityRef.current.clear();
	}

	// The transcript's own subscription, opened through the common layer like
	// every other one: a record written between the subscription being registered
	// and this page of history being read reaches the callback before the page
	// does, and would be applied and then overwritten by it. `useSubscription`
	// holds such a record until the page is in and replays it after — and this is
	// the one subscription where losing that record loses a message outright, as
	// it is newer than the history that just came back.
	//
	// Loading state is managed by the initial value and the reset above, so
	// re-subscribing on reconnect won't flash the spinner. It also stays true for
	// as long as `enabled` is false, which is what makes "waiting for the session
	// to resolve" and "waiting for its history" a single continuous wait for
	// callers timing a loading indicator against it.
	const subscribe = useCallback(
		(onNotification: (notification: ServerNotification) => void) =>
			chatMessagesSubscribe(sessionId, onNotification),
		[sessionId],
	);

	const handleSubscribed = useCallback(
		(initial: ChatMessagesSubscribeResult) => {
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
			// an earlier page is actually asked for with, so the sentinel can
			// never be left offering a page there is no way to request.
			setHasMoreHistory(initial.next_before_seq !== undefined);
			setLoadedHistoryPages(0);
			setHistoryError(null);
			nextBeforeSeqRef.current = initial.next_before_seq;
			backReferencesRef.current = initial.history.filter(isBackReference);
			boundaryTerminalRef.current = leadingTurnTerminal(initial.history);
			newestHistorySeqRef.current = newestSeq(initial.history);
			subscribedTurnRef.current = initial.turn;
			// Progress for the transcript being replaced.
			pendingActivityRef.current.clear();
			const replayed = replayHistory(initial.history);
			// The turn is the authority the records are missing: a transcript the
			// server died in the middle of ends with a bubble still streaming and
			// nothing in history that says otherwise. Older pages get the part of
			// this that is true of them as they are paged in.
			const settled = settleAgainstTurn(replayed, initial.turn);
			// What the calls still in flight last reported. History carries none —
			// a `tool_activity` is never recorded — so this is the whole of what a
			// client subscribing mid-run knows about a background task that started
			// half an hour ago.
			setMessages(
				initial.tool_activity
					? applyToolActivitySnapshot(settled, initial.tool_activity)
					: settled,
			);
			setIsLoadingHistory(false);
		},
		[],
	);

	const handleSubscribeError = useCallback((err: unknown) => {
		console.error("Failed to subscribe to chat messages:", err);
		// The wait is over either way: leaving the spinner up would promise a
		// transcript that is not coming.
		setIsLoadingHistory(false);
	}, []);

	useSubscription<ServerNotification, ChatMessagesSubscribeResult>(
		subscribe,
		chatMessagesUnsubscribe,
		handleNotification,
		{
			enabled,
			// A session belongs to its worktree, so switching does end this
			// subscription server-side — but it ends the session with it, and
			// `enabled` has already gone false by then. Resubscribing on switch
			// would only ask the new worktree about a session id it has never heard
			// of. See useSessionDetailSubscription, which is gated the same way.
			resubscribeOnWorktreeChange: false,
			onSubscribed: handleSubscribed,
			onError: handleSubscribeError,
		},
	);

	const loadMoreHistory = useCallback(async () => {
		const beforeSeq = nextBeforeSeqRef.current;
		if (isLoadingMoreRef.current || beforeSeq === undefined) return;

		const generation = historyGenerationRef.current;
		isLoadingMoreRef.current = true;
		setIsLoadingMoreHistory(true);
		setHistoryError(null);
		try {
			const page = await chatMessagesHistory(sessionId, beforeSeq);
			if (historyGenerationRef.current !== generation) return;

			const older = replayHistory(page.history);
			// Read now, not inside the updater: React calls that during a later
			// render, by which point these refs have moved on to describe this page
			// instead of the one above it.
			const catchUp = {
				boundaryTerminal: boundaryTerminalRef.current,
				backReferences: backReferencesRef.current,
				turn: subscribedTurnRef.current,
			};
			setMessages((prev) => prependHistoryPage(older, prev, catchUp));
			boundaryTerminalRef.current = leadingTurnTerminal(page.history);
			backReferencesRef.current = [
				...page.history.filter(isBackReference),
				...backReferencesRef.current,
			];
			nextBeforeSeqRef.current = page.next_before_seq;
			setHasMoreHistory(page.next_before_seq !== undefined);
			setLoadedHistoryPages((n) => n + 1);
		} catch (error) {
			if (historyGenerationRef.current !== generation) return;
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
	}, [sessionId]);

	const sendUserMessageHandler = useCallback(
		async (
			content: string,
			answering?: QuestionAnswerRecord[],
		): Promise<boolean> => {
			// Normalised once, so "present" and "non-empty" cannot come apart: an
			// empty list would otherwise echo a bubble drawn from no answers, send
			// no `answering`, and take the wrong branch on failure.
			const answers = answering?.length ? answering : undefined;
			const userMessageId = generateUUID();
			const assistantMessageId = generateUUID();

			const userMessage: UserMessage = {
				id: userMessageId,
				role: "user",
				content,
				status: "complete",
				createdAt: new Date(),
				// Echoed with the bubble so an answer draws as answers rather than
				// as the flattened text the agent reads.
				...(answers ? { answering: answers } : {}),
			};

			// Empty assistant message ready to receive streaming content
			const assistantMessage: AssistantMessage = {
				id: assistantMessageId,
				role: "assistant",
				parts: [],
				status: "sending",
				createdAt: new Date(),
			};

			// The same shaping a broadcast message gets, from the same function: a
			// message sent into a running turn neither closes that turn's bubble nor
			// gets a placeholder of its own, while one sent to an idle agent opens a
			// turn. The placeholder is passed as a thunk because the mid-turn shape
			// does not want one.
			setMessages((prev) =>
				appendUserMessage(prev, userMessage, () => assistantMessage),
			);

			try {
				// The server's reply is where this client learns the seq of its own
				// message — it is excluded from the broadcast carrying everyone else's.
				// Without it the bubble just added could not be forked from until the
				// session was reloaded. An older server sends none, which simply leaves
				// the message unaddressable, as every locally sent one used to be.
				const seq = await sendMessage(
					sessionId,
					content,
					answers && toAnswerParams(answers),
				);
				setMessages((prev) => {
					const stamped = stampMessageAnchorSeq(prev, userMessageId, seq);
					// The cards this message settled, and this client has to settle
					// them itself: the sender is left out of the broadcast that
					// carries the record, so nothing else is coming to do it. Only
					// after the send — a refused answer settles nothing.
					return answers ? applyAnswering(stamped, answers) : stamped;
				});
				return true;
			} catch (error) {
				console.error("Failed to send message:", error);
				// An answering send is refused whole — nothing was written, nothing
				// was delivered, and the questions are all still open — so the echo
				// is taken back out rather than left looking sent with a failure
				// pinned under it. The sheet is where the reason belongs: it holds
				// the drafts, and it is what the user is looking at.
				if (answers) {
					setMessages((prev) =>
						prev.filter(
							(m) => m.id !== userMessageId && m.id !== assistantMessageId,
						),
					);
					throw error;
				}
				// The server's reason is what tells a missing CLI apart from a dropped
				// connection; without it every failure reads the same.
				const reason =
					error instanceof Error && error.message
						? error.message
						: "Unknown error";
				const failure = `Failed to send message: ${reason}`;
				setMessages((prev) => {
					// The message opened a turn, so the placeholder standing in for the
					// reply is where the failure belongs.
					if (prev.some((m) => m.id === assistantMessageId)) {
						return prev.map((m): Message => {
							if (m.role === "assistant" && m.id === assistantMessageId) {
								return { ...m, status: "error", error: failure };
							}
							return m;
						});
					}

					// No placeholder means one of two things, and only the message itself
					// tells them apart: it went into a turn that was already running — no
					// placeholder is made for those — or the transcript on screen is no
					// longer the one it was sent to, the user having switched sessions
					// while the call was in flight. Reporting into that one would be
					// reporting into somebody else's conversation.
					const sentAt = prev.findIndex((m) => m.id === userMessageId);
					if (sentAt === -1) return prev;

					// Below the message it failed to deliver rather than at the end,
					// which by now may be several messages further down. Saying nothing
					// is the one option ruled out: the server does refuse a mid-turn send
					// while a permission or question is waiting, and the message would
					// otherwise sit in the transcript looking delivered.
					const reported = [...prev];
					reported.splice(sentAt + 1, 0, {
						...assistantMessage,
						status: "error",
						error: failure,
					});
					return reported;
				});
				return false;
			}
		},
		[sessionId],
	);

	const resetPrompt = useCallback(
		(requestId: string, status: "pending" | "expired") => {
			setMessages((prev) => resetPromptRequest(prev, requestId, status));
		},
		[],
	);

	const updatePermissionStatus = useCallback(
		(requestId: string, newStatus: "allowed" | "denied") => {
			setMessages((prev) =>
				updatePermissionRequestStatus(prev, requestId, newStatus),
			);
		},
		[],
	);

	// Whether a turn is open, and the optimistic half is load-bearing: between the
	// user pressing send and the server reporting `running` there is a round trip,
	// and a surface watching only the turn would leave them without Stop for the
	// length of it. What the turn removes is the half that was never reliable —
	// inferring liveness from the last bubble's status and a `process_ended` that
	// a restart never wrote (docs/lifecycle-ui.md §2.3).
	//
	// `sending` is the status of a placeholder this client made and the server has
	// yet to say anything about; located by the open bubble rather than by the end
	// of the list, because a second message typed inside that same round trip is
	// appended below it and would otherwise cancel the optimism that message needs
	// most.
	const openIndex = openAssistantIndex(messages);
	const open = openIndex >= 0 ? messages[openIndex] : undefined;
	const hasUnansweredEcho =
		open?.role === "assistant" && open.status === "sending";
	const turnOpen = hasUnansweredEcho || turn.phase !== "idle";

	// Whether the message the transcript ends on went into a turn that was already
	// running. Derived, never recorded: the record says what was typed at that
	// moment and cannot also carry whether the agent has picked it up — that half
	// changes, and a copy inside the record would start lying the moment it did
	// (AGENTS.md, "events are events, state is state"). Reading it back out of the
	// transcript costs nothing and is always current: the turn ending, or the
	// agent opening its own bubble below, retires it on its own.
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
