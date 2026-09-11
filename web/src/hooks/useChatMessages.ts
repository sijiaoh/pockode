import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyServerEvent,
	closePreviousTurn,
	expirePendingDialogs,
	normalizeEvent,
	readHistorySeq,
	replayHistory,
	settleRunningTasks,
	stampMessageAnchorSeq,
	updatePermissionRequestStatus,
	updateQuestionStatus as updateQuestionStatusReducer,
} from "../lib/messageReducer";
import { useSessionStore } from "../lib/sessionStore";
import { type ConnectionStatus, useWSStore } from "../lib/wsStore";
import type {
	AssistantMessage,
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
	isStreaming: boolean;
	isProcessRunning: boolean;
	mode: SessionMode;
	agentType: AgentType;
	isSessionActivated: boolean;
	status: ConnectionStatus;
	sendUserMessage: (content: string) => Promise<boolean>;
	interrupt: () => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	questionResponse: (params: QuestionResponseParams) => Promise<void>;
	setMode: (mode: SessionMode) => Promise<void>;
	setAgentType: (agentType: AgentType) => Promise<void>;
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
const { sendMessage, chatMessagesSubscribe, chatMessagesUnsubscribe } =
	useWSStore.getState().actions;

export function useChatMessages({
	sessionId,
	enabled = true,
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(true);
	const [isProcessRunning, setIsProcessRunning] = useState(false);
	const [mode, setModeState] = useState<SessionMode>("default");
	const [agentType, setAgentTypeState] = useState<AgentType>("claude");
	const subscriptionIdRef = useRef<string | null>(null);

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

	const handleNotification = useCallback((notification: ServerNotification) => {
		setIsProcessRunning(notification.type !== "process_ended");

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
					let messages = replayHistory(result.initial.history);
					// After server restart, history won't contain process_ended events
					// for processes that were killed. Use the authoritative process state
					// to expire any orphaned pending dialogs and settle Tasks that were
					// still running — nothing is left to report back on them.
					if (result.initial.state === "ended") {
						messages = expirePendingDialogs(messages);
						messages = settleRunningTasks(messages);
					}
					setMessages(messages);
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

	const setMode = useCallback(
		async (newMode: SessionMode) => {
			try {
				await actions.setSessionMode(sessionId, newMode);
				setModeState(newMode);
			} catch (error) {
				console.error("Failed to set mode:", error);
				throw error;
			}
		},
		[actions, sessionId],
	);

	const setAgentType = useCallback(
		async (newAgentType: AgentType) => {
			try {
				await actions.setSessionAgentType(sessionId, newAgentType);
				setAgentTypeState(newAgentType);
			} catch (error) {
				console.error("Failed to set agent type:", error);
				throw error;
			}
		},
		[actions, sessionId],
	);

	return {
		messages,
		isLoadingHistory,
		isStreaming,
		isProcessRunning,
		mode,
		agentType,
		isSessionActivated,
		status,
		sendUserMessage: sendUserMessageHandler,
		interrupt: useCallback(
			() => actions.interrupt(sessionId),
			[actions, sessionId],
		),
		permissionResponse: actions.permissionResponse,
		questionResponse: actions.questionResponse,
		setMode,
		setAgentType,
		updatePermissionStatus,
		updateQuestionStatus,
	};
}
