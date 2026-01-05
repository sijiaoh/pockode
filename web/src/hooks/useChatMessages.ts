import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyServerEvent,
	normalizeEvent,
	replayHistory,
} from "../lib/messageReducer";
import { getHistory } from "../lib/sessionApi";
import { useWSStore } from "../lib/wsStore";
import type {
	AssistantMessage,
	Message,
	PermissionResponseParams,
	PermissionStatus,
	QuestionResponseParams,
	QuestionStatus,
	ServerNotification,
	UserMessage,
} from "../types/message";
import { generateUUID } from "../utils/uuid";

export type { ConnectionStatus } from "../lib/wsStore";

interface UseChatMessagesOptions {
	sessionId: string;
}

interface UseChatMessagesReturn {
	messages: Message[];
	isLoadingHistory: boolean;
	isStreaming: boolean;
	isProcessRunning: boolean;
	status: ConnectionStatus;
	sendUserMessage: (content: string) => Promise<boolean>;
	interrupt: () => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	questionResponse: (params: QuestionResponseParams) => Promise<void>;
	updatePermissionStatus: (requestId: string, status: PermissionStatus) => void;
	updateQuestionStatus: (
		requestId: string,
		status: QuestionStatus,
		answers?: Record<string, string>,
	) => void;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

// Actions are stable references - get once at module level
const { connect, attach, sendMessage, subscribeNotification } =
	useWSStore.getState().actions;

export function useChatMessages({
	sessionId,
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);
	const [isProcessRunning, setIsProcessRunning] = useState(false);
	const hasConnectedOnceRef = useRef(false);

	const status = useWSStore((state) => state.status);
	const actions = useWSStore((state) => state.actions);

	const handleNotification = useCallback(
		(notification: ServerNotification) => {
			if (notification.session_id !== sessionId) {
				return;
			}

			// Update process running state
			if (notification.type === "process_ended") {
				setIsProcessRunning(false);
			} else {
				// Any event from process means it's running
				setIsProcessRunning(true);
			}

			const event = normalizeEvent(notification);
			setMessages((prev) => applyServerEvent(prev, event));
		},
		[sessionId],
	);

	// Subscribe to notifications
	useEffect(() => {
		return subscribeNotification(handleNotification);
	}, [handleNotification]);

	// Connect on mount (only once per app lifecycle)
	useEffect(() => {
		const currentStatus = useWSStore.getState().status;
		if (currentStatus === "disconnected") {
			connect();
		}
	}, []);

	useEffect(() => {
		setMessages([]);
		setIsProcessRunning(false);
		hasConnectedOnceRef.current = false;

		async function loadHistory() {
			setIsLoadingHistory(true);
			try {
				const history = await getHistory(sessionId);
				const replayedMessages = replayHistory(history);
				setMessages(replayedMessages);
			} catch (err) {
				console.error("Failed to load history:", err);
			} finally {
				setIsLoadingHistory(false);
			}
		}

		loadHistory();
	}, [sessionId]);

	// Attach to session when connected (enables receiving events without sending a message)
	useEffect(() => {
		if (status === "connected") {
			attach(sessionId)
				.then((result) => {
					setIsProcessRunning(result.process_running);
				})
				.catch((err) => console.error("Attach failed:", err));

			// On reconnect, reload history to sync messages missed during disconnect
			if (hasConnectedOnceRef.current) {
				getHistory(sessionId)
					.then((history) => setMessages(replayHistory(history)))
					.catch((err) => console.error("History sync failed:", err));
			}
			hasConnectedOnceRef.current = true;
		}
	}, [status, sessionId]);

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

			setMessages((prev) => [...prev, userMessage, assistantMessage]);

			try {
				await sendMessage(sessionId, content);
				return true;
			} catch (error) {
				console.error("Failed to send message:", error);
				setMessages((prev) =>
					prev.map((m): Message => {
						if (m.role === "assistant" && m.id === assistantMessageId) {
							return { ...m, status: "error", error: "Failed to send message" };
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
		(requestId: string, newStatus: PermissionStatus) => {
			setMessages((prev) =>
				prev.map((msg): Message => {
					if (msg.role !== "assistant") return msg;
					return {
						...msg,
						parts: msg.parts.map((part) => {
							if (
								part.type === "permission_request" &&
								part.request.requestId === requestId
							) {
								return { ...part, status: newStatus };
							}
							return part;
						}),
					};
				}),
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
				prev.map((msg): Message => {
					if (msg.role !== "assistant") return msg;
					return {
						...msg,
						parts: msg.parts.map((part) => {
							if (
								part.type === "ask_user_question" &&
								part.request.requestId === requestId
							) {
								return { ...part, status: newStatus, answers };
							}
							return part;
						}),
					};
				}),
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

	return {
		messages,
		isLoadingHistory,
		isStreaming,
		isProcessRunning,
		status,
		sendUserMessage: sendUserMessageHandler,
		interrupt: useCallback(
			() => actions.interrupt(sessionId),
			[actions, sessionId],
		),
		permissionResponse: actions.permissionResponse,
		questionResponse: actions.questionResponse,
		updatePermissionStatus,
		updateQuestionStatus,
	};
}
