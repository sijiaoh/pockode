import { useCallback, useState } from "react";
import { useWebSocket } from "../../hooks/useWebSocket";
import type { Message, WSServerMessage } from "../../types/message";
import { generateUUID } from "../../utils/uuid";
import InputBar from "./InputBar";
import MessageList from "./MessageList";

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
						{ name: serverMsg.tool_name ?? "", input: serverMsg.tool_input },
					];
					break;
				case "tool_result":
					// Update the last tool call's result (immutable update)
					if (message.toolCalls && message.toolCalls.length > 0) {
						const updatedToolCalls = [...message.toolCalls];
						const lastIndex = updatedToolCalls.length - 1;
						updatedToolCalls[lastIndex] = {
							...updatedToolCalls[lastIndex],
							result: serverMsg.content,
						};
						message.toolCalls = updatedToolCalls;
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
			send({
				type: "message",
				id: assistantMessageId,
				content,
			});
		},
		[send],
	);

	const statusText =
		status === "connected"
			? "Connected"
			: status === "error"
				? "Connection Error"
				: status === "disconnected"
					? "Disconnected"
					: "Connecting...";

	const statusColor =
		status === "connected"
			? "text-green-400"
			: status === "error"
				? "text-red-400"
				: "text-yellow-400";

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
