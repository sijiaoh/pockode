import { useCallback, useRef, useState } from "react";
import {
	applyServerEvent,
	closePreviousTurn,
	isBackReference,
	isTurnTerminal,
	normalizeEvent,
	prependHistoryPage,
	readHistorySeq,
	replayHistory,
	settleAfterProcessGone,
	stampMessageAnchorSeq,
	updatePermissionRequestStatus,
	updateQuestionStatus as updateQuestionStatusReducer,
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
	QuestionResponseParams,
	QuestionStatus,
	ServerNotification,
	SessionMode,
	UserMessage,
} from "../types/message";
import type { AgentType } from "../types/settings";
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
	isStreaming: boolean;
	isProcessRunning: boolean;
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
	sendUserMessage: (content: string) => Promise<boolean>;
	interrupt: () => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	questionResponse: (params: QuestionResponseParams) => Promise<void>;
	setMode: (mode: SessionMode) => Promise<void>;
	setAgentType: (agentType: AgentType) => Promise<void>;
	setModel: (model: string) => Promise<void>;
	setEffort: (effort: string) => Promise<void>;
	updatePermissionStatus: (
		requestId: string,
		status: "allowed" | "denied",
	) => void;
	updateQuestionStatus: (
		requestId: string,
		status: QuestionStatus,
		answers?: Record<string, string>,
	) => void;
}

// Actions are stable references - get once at module level
const {
	sendMessage,
	chatMessagesSubscribe,
	chatMessagesHistory,
	chatMessagesUnsubscribe,
} = useWSStore.getState().actions;

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
	const [isProcessRunning, setIsProcessRunning] = useState(false);
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
	// Set when the process was already gone at subscribe time. A process killed
	// by a restart leaves no `process_ended` in history, so that fact reaches an
	// older page from here rather than through the back-references; one that ends
	// while connected broadcasts the record and travels with them.
	const processGoneRef = useRef(false);
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

	const handleNotification = useCallback((notification: ServerNotification) => {
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

		setIsProcessRunning(notification.type !== "process_ended");

		if (isBackReference(notification)) {
			backReferencesRef.current.push(notification);
		}
		const event = normalizeEvent(notification);
		setMessages((prev) => applyServerEvent(prev, event, seq));
	}, []);

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
		setIsProcessRunning(false);
		setSettingError(null);
		setHasMoreHistory(false);
		setIsLoadingMoreHistory(false);
		setHistoryError(null);
		setLoadedHistoryPages(0);
		nextBeforeSeqRef.current = undefined;
		backReferencesRef.current = [];
		boundaryTerminalRef.current = undefined;
		newestHistorySeqRef.current = undefined;
		processGoneRef.current = false;
		isLoadingMoreRef.current = false;
		historyGenerationRef.current++;
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
			setIsProcessRunning(initial.state !== "ended");
			// Subscribing hands back the newest page only, and a re-subscribe
			// hands it back again: pages paged in before a reconnect are gone, so
			// the paging state starts over with them.
			historyGenerationRef.current++;
			isLoadingMoreRef.current = false;
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
			processGoneRef.current = initial.state === "ended";
			const replayed = replayHistory(initial.history);
			// After server restart, history won't contain process_ended events
			// for processes that were killed. Use the authoritative process
			// state instead — older pages get the same treatment from
			// `processGoneRef` as they are paged in.
			setMessages(
				processGoneRef.current ? settleAfterProcessGone(replayed) : replayed,
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
				processEnded: processGoneRef.current,
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
		async (content: string): Promise<boolean> => {
			const userMessageId = generateUUID();
			const assistantMessageId = generateUUID();

			const userMessage: UserMessage = {
				id: userMessageId,
				role: "user",
				content,
				status: "complete",
				createdAt: new Date(),
			};

			// Empty assistant message ready to receive streaming content
			const assistantMessage: AssistantMessage = {
				id: assistantMessageId,
				role: "assistant",
				parts: [],
				status: "sending",
				createdAt: new Date(),
			};

			// Same turn handling a broadcast message gets: a locally echoed message
			// starts a new turn too, so whatever the agent was mid-way through is
			// closed out and an unanswered placeholder does not linger as a blank
			// bubble above the one just added.
			setMessages((prev) => [
				...closePreviousTurn(prev),
				userMessage,
				assistantMessage,
			]);

			try {
				// The server's reply is where this client learns the seq of its own
				// message — it is excluded from the broadcast carrying everyone else's.
				// Without it the bubble just added could not be forked from until the
				// session was reloaded. An older server sends none, which simply leaves
				// the message unaddressable, as every locally sent one used to be.
				const seq = await sendMessage(sessionId, content);
				setMessages((prev) => stampMessageAnchorSeq(prev, userMessageId, seq));
				return true;
			} catch (error) {
				console.error("Failed to send message:", error);
				// The server's reason is what tells a missing CLI apart from a dropped
				// connection; without it every failure reads the same.
				const reason =
					error instanceof Error && error.message
						? error.message
						: "Unknown error";
				setMessages((prev) =>
					prev.map((m): Message => {
						if (m.role === "assistant" && m.id === assistantMessageId) {
							return {
								...m,
								status: "error",
								error: `Failed to send message: ${reason}`,
							};
						}
						return m;
					}),
				);
				return false;
			}
		},
		[sessionId],
	);

	const updatePermissionStatus = useCallback(
		(requestId: string, newStatus: "allowed" | "denied") => {
			setMessages((prev) =>
				updatePermissionRequestStatus(prev, requestId, newStatus),
			);
		},
		[],
	);

	const updateQuestionStatus = useCallback(
		(
			requestId: string,
			newStatus: QuestionStatus,
			answers?: Record<string, string>,
		) => {
			setMessages((prev) =>
				updateQuestionStatusReducer(
					prev,
					requestId,
					newStatus,
					answers ?? null,
				),
			);
		},
		[],
	);

	// isStreaming controls input blocking
	// - sending: always block (waiting for server response)
	// - streaming: only block when process is running
	const last = messages[messages.length - 1];
	const lastIsSending = last?.role === "assistant" && last.status === "sending";
	const lastIsStreaming =
		last?.role === "assistant" && last.status === "streaming";
	const isStreaming = lastIsSending || (lastIsStreaming && isProcessRunning);

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
		isStreaming,
		isProcessRunning,
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
		questionResponse: actions.questionResponse,
		setMode,
		setAgentType,
		setModel,
		setEffort,
		updatePermissionStatus,
		updateQuestionStatus,
	};
}
