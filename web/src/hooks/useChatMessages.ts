import { useCallback, useEffect, useRef, useState } from "react";
import {
	applyServerEvent,
	normalizeEvent,
	replayHistory,
	updatePermissionRequestStatus,
	updateQuestionStatus as updateQuestionStatusReducer,
} from "../lib/messageReducer";
import { type ConnectionStatus, useWSStore } from "../lib/wsStore";
import type {
	AssistantMessage,
	Message,
	PermissionResponseParams,
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
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);
	const [isProcessRunning, setIsProcessRunning] = useState(false);
	const subscriptionIdRef = useRef<string | null>(null);

	const status = useWSStore((state) => state.status);
	const actions = useWSStore((state) => state.actions);

	const handleNotification = useCallback((notification: ServerNotification) => {
		// Update process running state
		if (notification.type === "process_ended") {
			setIsProcessRunning(false);
		} else {
			// Any event from process means it's running
			setIsProcessRunning(true);
		}

		const event = normalizeEvent(notification);
		setMessages((prev) => applyServerEvent(prev, event));
	}, []);

	// Reset state when sessionId changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on sessionId change
	useEffect(() => {
		setMessages([]);
		setIsProcessRunning(false);
	}, [sessionId]);

	// Subscribe to chat events when connected
	useEffect(() => {
		if (status !== "connected") {
			return;
		}

		let cancelled = false;

		async function subscribe() {
			setIsLoadingHistory(true);
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
					setIsProcessRunning(result.initial.process_running);
					setMessages(replayHistory(result.initial.history));
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
	}, [status, sessionId, handleNotification]);

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
