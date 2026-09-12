import { useCallback, useEffect, useRef, useState } from "react";
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
import { useSessionStore } from "../lib/sessionStore";
import { type ConnectionStatus, useWSStore } from "../lib/wsStore";
import type {
	AssistantMessage,
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

export type { ConnectionStatus } from "../lib/wsStore";

interface UseChatMessagesOptions {
	sessionId: string;
	/**
	 * Subscribe only once `sessionId` is known to belong to the worktree the
	 * connection is bound to. Subscribing earlier (mid worktree switch) targets a
	 * session the server can't see yet.
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
	mode: SessionMode;
	agentType: AgentType;
	model: string;
	effort: string;
	isSessionActivated: boolean;
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

export function useChatMessages({
	sessionId,
	enabled = true,
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(true);
	const [isProcessRunning, setIsProcessRunning] = useState(false);
	const [mode, setModeState] = useState<SessionMode>("default");
	const [agentType, setAgentTypeState] = useState<AgentType>("claude");
	const [model, setModelState] = useState("");
	const [effort, setEffortState] = useState("");
	const [settingError, setSettingError] = useState<string | null>(null);
	const [hasMoreHistory, setHasMoreHistory] = useState(false);
	const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [loadedHistoryPages, setLoadedHistoryPages] = useState(0);
	const subscriptionIdRef = useRef<string | null>(null);
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
	// Identifies which transcript a page request was made against. A session
	// switch or a re-subscribe replaces the transcript wholesale, and a page still
	// in flight would otherwise be spliced into the one that took its place.
	const historyGenerationRef = useRef(0);
	const isLoadingMoreRef = useRef(false);

	const status = useWSStore((state) => state.status);
	const actions = useWSStore((state) => state.actions);

	// Sync mode from session store (updated via session list notifications)
	const sessionModeFromStore = useSessionStore(
		(state) => state.sessions.find((s) => s.id === sessionId)?.mode,
	);
	useEffect(() => {
		if (sessionModeFromStore !== undefined) {
			setModeState(sessionModeFromStore);
		}
	}, [sessionModeFromStore]);

	// Sync agentType from session store (updated via session list notifications)
	const sessionAgentTypeFromStore = useSessionStore(
		(state) => state.sessions.find((s) => s.id === sessionId)?.agent_type,
	);
	// The server refuses to change agent type once the agent has answered here,
	// and says so through this flag. The transcript is not a substitute for it: a
	// first turn that failed before the agent said anything leaves messages behind
	// in a session that never started, and that is exactly when switching agents
	// is the only way out.
	const isSessionActivated = useSessionStore(
		(state) =>
			state.sessions.find((s) => s.id === sessionId)?.activated ?? false,
	);
	useEffect(() => {
		if (sessionAgentTypeFromStore !== undefined) {
			setAgentTypeState(sessionAgentTypeFromStore);
		}
	}, [sessionAgentTypeFromStore]);

	// Sync model from session store (updated via session list notifications).
	// This is also how a model reset arrives: the server drops a model that does
	// not belong to the newly chosen agent, so the value is only ever read back,
	// never cleared here.
	const sessionModelFromStore = useSessionStore(
		(state) => state.sessions.find((s) => s.id === sessionId)?.model,
	);
	useEffect(() => {
		if (sessionModelFromStore !== undefined) {
			setModelState(sessionModelFromStore);
		}
	}, [sessionModelFromStore]);

	// Same for the effort level, and for the same reason: choosing an agent that
	// has no such level drops it server-side, and this is how that arrives.
	const sessionEffortFromStore = useSessionStore(
		(state) => state.sessions.find((s) => s.id === sessionId)?.effort,
	);
	useEffect(() => {
		if (sessionEffortFromStore !== undefined) {
			setEffortState(sessionEffortFromStore);
		}
	}, [sessionEffortFromStore]);

	const handleNotification = useCallback((notification: ServerNotification) => {
		setIsProcessRunning(notification.type !== "process_ended");

		if (isBackReference(notification)) {
			backReferencesRef.current.push(notification);
		}
		const event = normalizeEvent(notification);
		const seq = readHistorySeq(notification);
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
		setModeState("default");
		setAgentTypeState("claude");
		setModelState("");
		setEffortState("");
		setSettingError(null);
		setHasMoreHistory(false);
		setIsLoadingMoreHistory(false);
		setHistoryError(null);
		setLoadedHistoryPages(0);
		nextBeforeSeqRef.current = undefined;
		backReferencesRef.current = [];
		boundaryTerminalRef.current = undefined;
		processGoneRef.current = false;
		isLoadingMoreRef.current = false;
		historyGenerationRef.current++;
	}

	// Subscribe to chat events when connected.
	// Loading state is managed by the initial value and the reset above, so
	// re-subscribing on reconnect won't flash the spinner. It also stays true for
	// as long as `enabled` is false, which is what makes "waiting for the session
	// to resolve" and "waiting for its history" a single continuous wait for
	// callers timing a loading indicator against it.
	useEffect(() => {
		if (!enabled || status !== "connected") {
			return;
		}

		let cancelled = false;

		async function subscribe() {
			try {
				const result = await chatMessagesSubscribe(
					sessionId,
					handleNotification,
				);
				if (cancelled) {
					// Cleanup if component unmounted during subscribe
					await chatMessagesUnsubscribe(result.id);
					return;
				}
				subscriptionIdRef.current = result.id;
				if (result.initial) {
					setIsProcessRunning(result.initial.state !== "ended");
					setModeState(result.initial.mode);
					setAgentTypeState(result.initial.agent_type);
					setModelState(result.initial.model);
					setEffortState(result.initial.effort);
					// Subscribing hands back the newest page only, and a re-subscribe
					// hands it back again: pages paged in before a reconnect are gone, so
					// the paging state starts over with them.
					historyGenerationRef.current++;
					isLoadingMoreRef.current = false;
					// Keyed on the cursor rather than on `has_more`: the cursor is what
					// an earlier page is actually asked for with, so the sentinel can
					// never be left offering a page there is no way to request.
					setHasMoreHistory(result.initial.next_before_seq !== undefined);
					setLoadedHistoryPages(0);
					setHistoryError(null);
					nextBeforeSeqRef.current = result.initial.next_before_seq;
					backReferencesRef.current =
						result.initial.history.filter(isBackReference);
					boundaryTerminalRef.current = leadingTurnTerminal(
						result.initial.history,
					);
					processGoneRef.current = result.initial.state === "ended";
					const replayed = replayHistory(result.initial.history);
					// After server restart, history won't contain process_ended events
					// for processes that were killed. Use the authoritative process
					// state instead — older pages get the same treatment from
					// `processGoneRef` as they are paged in.
					setMessages(
						processGoneRef.current
							? settleAfterProcessGone(replayed)
							: replayed,
					);
				}
			} catch (err) {
				console.error("Failed to subscribe to chat messages:", err);
			} finally {
				if (!cancelled) {
					setIsLoadingHistory(false);
				}
			}
		}

		subscribe();

		return () => {
			cancelled = true;
			if (subscriptionIdRef.current) {
				chatMessagesUnsubscribe(subscriptionIdRef.current).catch(() => {
					// Ignore errors (connection might be closed)
				});
				subscriptionIdRef.current = null;
			}
		};
	}, [enabled, status, sessionId, handleNotification]);

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

	// One path for every session setting: each applies the new value only
	// once the server has taken it, so a rejection leaves the control showing what
	// the session is actually set to, and records why for the UI to show.
	const applySetting = useCallback(
		async <T>(
			what: string,
			value: T,
			send: (value: T) => Promise<void>,
			apply: (value: T) => void,
		) => {
			try {
				await send(value);
				apply(value);
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
			applySetting(
				"mode",
				newMode,
				(m) => actions.setSessionMode(sessionId, m),
				setModeState,
			),
		[applySetting, actions, sessionId],
	);

	const setAgentType = useCallback(
		(newAgentType: AgentType) =>
			applySetting(
				"agent",
				newAgentType,
				(a) => actions.setSessionAgentType(sessionId, a),
				setAgentTypeState,
			),
		[applySetting, actions, sessionId],
	);

	const setModel = useCallback(
		(newModel: string) =>
			applySetting(
				"model",
				newModel,
				(m) => actions.setSessionModel(sessionId, m),
				setModelState,
			),
		[applySetting, actions, sessionId],
	);

	const setEffort = useCallback(
		(newEffort: string) =>
			applySetting(
				"effort",
				newEffort,
				(e) => actions.setSessionEffort(sessionId, e),
				setEffortState,
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
