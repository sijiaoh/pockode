import { useCallback, useEffect, useState } from "react";
import {
	applyServerEvent,
	normalizeEvent,
	replayHistory,
} from "../lib/messageReducer";
import { getHistory } from "../lib/sessionApi";
import type {
	Message,
	WSClientMessage,
	WSServerMessage,
} from "../types/message";
import { generateUUID } from "../utils/uuid";
import { type ConnectionStatus, useWebSocket } from "./useWebSocket";

export type { ConnectionStatus };

interface UseChatMessagesOptions {
	sessionId: string;
	onServerMessage?: (msg: WSServerMessage) => void;
}

interface UseChatMessagesReturn {
	messages: Message[];
	isLoadingHistory: boolean;
	isStreaming: boolean;
	status: ConnectionStatus;
	send: (msg: WSClientMessage) => boolean;
	sendUserMessage: (content: string) => boolean;
}

export function useChatMessages({
	sessionId,
	onServerMessage,
}: UseChatMessagesOptions): UseChatMessagesReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoadingHistory, setIsLoadingHistory] = useState(false);

	const handleServerMessage = useCallback(
		(serverMsg: WSServerMessage) => {
			if (serverMsg.session_id && serverMsg.session_id !== sessionId) {
				return;
			}

			// Delegate dialog events to parent; message events handled here
			if (
				serverMsg.type === "permission_request" ||
				serverMsg.type === "ask_user_question"
			) {
				onServerMessage?.(serverMsg);
				return;
			}

			const event = normalizeEvent(serverMsg);
			setMessages((prev) => applyServerEvent(prev, event));
		},
		[sessionId, onServerMessage],
	);

	const { status, send } = useWebSocket({
		onMessage: handleServerMessage,
	});

	useEffect(() => {
		setMessages([]);

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

	const sendUserMessage = useCallback(
		(content: string): boolean => {
			const userMessageId = generateUUID();
			const assistantMessageId = generateUUID();

			const userMessage: Message = {
				id: userMessageId,
				role: "user",
				content,
				status: "complete",
				createdAt: new Date(),
			};

			// Empty assistant message ready to receive streaming content
			const assistantMessage: Message = {
				id: assistantMessageId,
				role: "assistant",
				content: "",
				status: "sending",
				createdAt: new Date(),
			};

			setMessages((prev) => [...prev, userMessage, assistantMessage]);

			const sent = send({
				type: "message",
				content,
				session_id: sessionId,
			});

			if (!sent) {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantMessageId
							? { ...m, status: "error", error: "Failed to send message" }
							: m,
					),
				);
			}

			return sent;
		},
		[send, sessionId],
	);

	const isStreaming = messages.some(
		(m) => m.status === "sending" || m.status === "streaming",
	);

	return {
		messages,
		isLoadingHistory,
		isStreaming,
		status,
		send,
		sendUserMessage,
	};
}
