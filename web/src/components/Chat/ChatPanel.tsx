import { useCallback, useState } from "react";
import { type ConnectionStatus, useWebSocket } from "../../hooks/useWebSocket";
import type { Message, WSServerMessage } from "../../types/message";
import { generateUUID } from "../../utils/uuid";
import InputBar from "./InputBar";
import MessageList from "./MessageList";

const STATUS_CONFIG: Record<ConnectionStatus, { text: string; color: string }> =
	{
		connected: { text: "Connected", color: "text-green-400" },
		error: { text: "Connection Error", color: "text-red-400" },
		disconnected: { text: "Disconnected", color: "text-yellow-400" },
		connecting: { text: "Connecting...", color: "text-yellow-400" },
	};

function ChatPanel() {
	const [messages, setMessages] = useState<Message[]>([]);

	const handleServerMessage = useCallback((serverMsg: WSServerMessage) => {
		setMessages((prev) => {
			const index = prev.findIndex((m) => m.id === serverMsg.message_id);
			if (index === -1) return prev;

			const updated = [...prev];
			const message = { ...updated[index] };

			switch (serverMsg.type) {
				case "text":
					message.content += serverMsg.content ?? "";
					message.status = "streaming";
					break;
				case "tool_call":
					message.toolCalls = [
						...(message.toolCalls ?? []),
						{
							id: serverMsg.tool_use_id,
							name: serverMsg.tool_name ?? "",
							input: serverMsg.tool_input,
						},
					];
					break;
				case "tool_result":
					// Match tool result to tool call by id
					if (message.toolCalls && serverMsg.tool_use_id) {
						message.toolCalls = message.toolCalls.map((tc) =>
							tc.id === serverMsg.tool_use_id
								? { ...tc, result: serverMsg.tool_result }
								: tc,
						);
					}
					break;
				case "done":
					message.status = "complete";
					break;
				case "error":
					message.status = "error";
					message.error = serverMsg.error;
					break;
			}

			updated[index] = message;
			return updated;
		});
	}, []);

	const { status, send } = useWebSocket({
		onMessage: handleServerMessage,
	});

	const handleSend = useCallback(
		(content: string) => {
			const userMessageId = generateUUID();
			const assistantMessageId = generateUUID();

			// Add user message
			const userMessage: Message = {
				id: userMessageId,
				role: "user",
				content,
				status: "complete",
				createdAt: new Date(),
			};

			// Add empty AI message (ready to receive streaming content)
			const assistantMessage: Message = {
				id: assistantMessageId,
				role: "assistant",
				content: "",
				status: "sending",
				createdAt: new Date(),
			};

			setMessages((prev) => [...prev, userMessage, assistantMessage]);

			// Send to server
			const sent = send({
				type: "message",
				id: assistantMessageId,
				content,
			});

			// Handle send failure
			if (!sent) {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantMessageId
							? { ...m, status: "error", error: "Failed to send message" }
							: m,
					),
				);
			}
		},
		[send],
	);

	const { text: statusText, color: statusColor } = STATUS_CONFIG[status];

	return (
		<div className="flex h-screen flex-col bg-gray-900">
			<header className="flex items-center justify-between border-b border-gray-700 p-4">
				<h1 className="text-xl font-bold text-white">Pockode</h1>
				<span className={`text-sm ${statusColor}`}>{statusText}</span>
			</header>
			<MessageList messages={messages} />
			<InputBar onSend={handleSend} disabled={status !== "connected"} />
		</div>
	);
}

export default ChatPanel;
