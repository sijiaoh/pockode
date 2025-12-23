import { useCallback, useEffect, useState } from "react";
import { type ConnectionStatus, useWebSocket } from "../../hooks/useWebSocket";
import type {
	Message,
	PermissionRequest,
	WSServerMessage,
} from "../../types/message";
import { generateUUID } from "../../utils/uuid";
import InputBar from "./InputBar";
import MessageList from "./MessageList";
import PermissionDialog from "./PermissionDialog";

interface Props {
	onLogout?: () => void;
}

const STATUS_CONFIG: Record<ConnectionStatus, { text: string; color: string }> =
	{
		connected: { text: "Connected", color: "text-green-400" },
		error: { text: "Connection Error", color: "text-red-400" },
		disconnected: { text: "Disconnected", color: "text-yellow-400" },
		connecting: { text: "Connecting...", color: "text-yellow-400" },
	};

function ChatPanel({ onLogout }: Props) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);

	const handleServerMessage = useCallback((serverMsg: WSServerMessage) => {
		// Handle permission request
		if (serverMsg.type === "permission_request") {
			setPermissionRequest({
				requestId: serverMsg.request_id ?? "",
				toolName: serverMsg.tool_name ?? "",
				toolInput: serverMsg.tool_input,
				toolUseId: serverMsg.tool_use_id,
			});
			return;
		}

		// Handle system messages independently (e.g., login prompts before any message)
		if (serverMsg.type === "system") {
			setMessages((prev) => {
				const systemMessage: Message = {
					id: generateUUID(),
					role: "assistant",
					content: "",
					parts: [{ type: "system", content: serverMsg.content ?? "" }],
					status: "complete",
					createdAt: new Date(),
				};
				return [...prev, systemMessage];
			});
			return;
		}

		setMessages((prev) => {
			// Find the current pending message (sending or streaming)
			const index = prev.findIndex(
				(m) => m.status === "sending" || m.status === "streaming",
			);
			if (index === -1) return prev;

			const updated = [...prev];
			const message = { ...updated[index] };
			const parts = [...(message.parts ?? [])];

			switch (serverMsg.type) {
				case "text": {
					// Append to last text part or create new one
					const lastPart = parts[parts.length - 1];
					if (lastPart?.type === "text") {
						parts[parts.length - 1] = {
							type: "text",
							content: lastPart.content + (serverMsg.content ?? ""),
						};
					} else {
						parts.push({ type: "text", content: serverMsg.content ?? "" });
					}
					message.parts = parts;
					message.status = "streaming";
					break;
				}
				case "tool_call":
					parts.push({
						type: "tool_call",
						tool: {
							id: serverMsg.tool_use_id,
							name: serverMsg.tool_name ?? "",
							input: serverMsg.tool_input,
						},
					});
					message.parts = parts;
					break;
				case "tool_result": {
					// Find and update the matching tool call
					const toolId = serverMsg.tool_use_id;
					if (toolId) {
						message.parts = parts.map((part) =>
							part.type === "tool_call" && part.tool.id === toolId
								? {
										...part,
										tool: { ...part.tool, result: serverMsg.tool_result },
									}
								: part,
						);
					}
					break;
				}
				case "done":
					message.status = "complete";
					break;
				case "interrupted":
					message.status = "interrupted";
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

			// Generate sessionId on first message if not already set
			let currentSessionId = sessionId;
			if (!currentSessionId) {
				currentSessionId = generateUUID();
				setSessionId(currentSessionId);
			}

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

			// Send to server with session_id
			const sent = send({
				type: "message",
				content,
				session_id: currentSessionId,
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
		[send, sessionId],
	);

	const handlePermissionResponse = useCallback(
		(allow: boolean) => {
			if (!permissionRequest || !sessionId) return;

			send({
				type: "permission_response",
				session_id: sessionId,
				request_id: permissionRequest.requestId,
				allow,
			});

			setPermissionRequest(null);
		},
		[send, permissionRequest, sessionId],
	);

	// Check if AI is currently streaming a response
	const isStreaming = messages.some(
		(m) => m.status === "sending" || m.status === "streaming",
	);

	// Handle interrupt request
	const handleInterrupt = useCallback(() => {
		if (!sessionId) return;

		send({
			type: "interrupt",
			session_id: sessionId,
		});
	}, [send, sessionId]);

	// Esc key to interrupt streaming
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isStreaming) {
				handleInterrupt();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isStreaming, handleInterrupt]);

	const { text: statusText, color: statusColor } = STATUS_CONFIG[status];

	return (
		<div className="flex h-screen flex-col bg-gray-900">
			<header className="flex items-center justify-between border-b border-gray-700 p-4">
				<h1 className="text-xl font-bold text-white">Pockode</h1>
				<div className="flex items-center gap-4">
					<span className={`text-sm ${statusColor}`}>{statusText}</span>
					{onLogout && (
						<button
							type="button"
							onClick={onLogout}
							className="text-sm text-gray-400 hover:text-white"
						>
							Logout
						</button>
					)}
				</div>
			</header>
			<MessageList messages={messages} />
			<InputBar
				onSend={handleSend}
				disabled={status !== "connected"}
				isStreaming={isStreaming}
				onInterrupt={handleInterrupt}
			/>

			{permissionRequest && (
				<PermissionDialog
					request={permissionRequest}
					onAllow={() => handlePermissionResponse(true)}
					onDeny={() => handlePermissionResponse(false)}
				/>
			)}
		</div>
	);
}

export default ChatPanel;
