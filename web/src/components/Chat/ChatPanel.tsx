import { useCallback, useEffect, useState } from "react";
import { type ConnectionStatus, useWebSocket } from "../../hooks/useWebSocket";
import { getHistory } from "../../lib/sessionApi";
import type {
	ContentPart,
	Message,
	PermissionRequest,
	WSServerMessage,
} from "../../types/message";
import { generateUUID } from "../../utils/uuid";
import InputBar from "./InputBar";
import MessageList from "./MessageList";
import PermissionDialog from "./PermissionDialog";

// Normalized event with camelCase (internal representation)
interface NormalizedEvent {
	type: string;
	content?: string;
	toolUseId?: string;
	toolName?: string;
	toolInput?: unknown;
	toolResult?: string;
	error?: string;
}

// Convert snake_case server event to camelCase
function normalizeEvent(
	e: WSServerMessage | Record<string, unknown>,
): NormalizedEvent {
	const record = e as Record<string, unknown>;
	return {
		type: record.type as string,
		content: record.content as string | undefined,
		toolUseId: record.tool_use_id as string | undefined,
		toolName: record.tool_name as string | undefined,
		toolInput: record.tool_input,
		toolResult: record.tool_result as string | undefined,
		error: record.error as string | undefined,
	};
}

// Apply an event to message parts, returning updated parts
function applyEventToParts(
	parts: ContentPart[],
	event: NormalizedEvent,
): ContentPart[] {
	switch (event.type) {
		case "text": {
			const lastPart = parts[parts.length - 1];
			if (lastPart?.type === "text") {
				return [
					...parts.slice(0, -1),
					{ type: "text", content: lastPart.content + (event.content ?? "") },
				];
			}
			return [...parts, { type: "text", content: event.content ?? "" }];
		}
		case "tool_call":
			return [
				...parts,
				{
					type: "tool_call",
					tool: {
						id: event.toolUseId ?? "",
						name: event.toolName ?? "",
						input: event.toolInput,
					},
				},
			];
		case "tool_result":
			return parts.map((part) =>
				part.type === "tool_call" && part.tool.id === event.toolUseId
					? { ...part, tool: { ...part.tool, result: event.toolResult ?? "" } }
					: part,
			);
		default:
			return parts;
	}
}

// Create a new assistant message
function createAssistantMessage(
	status: Message["status"] = "streaming",
): Message {
	return {
		id: generateUUID(),
		role: "assistant",
		content: "",
		parts: [],
		status,
		createdAt: new Date(),
	};
}

// Apply a server event to message list (pure function, shared by replay and real-time)
function applyServerEvent(
	messages: Message[],
	event: NormalizedEvent,
): Message[] {
	// System messages are always standalone
	if (event.type === "system") {
		const systemMessage = createAssistantMessage("complete");
		systemMessage.parts = [{ type: "system", content: event.content ?? "" }];
		return [...messages, systemMessage];
	}

	// Find current assistant (sending or streaming)
	let index = messages.findIndex(
		(m) => m.status === "sending" || m.status === "streaming",
	);

	// No current assistant? Create one to hold the orphan event
	if (index === -1) {
		const newAssistant = createAssistantMessage();
		messages = [...messages, newAssistant];
		index = messages.length - 1;
	}

	// Apply event to the assistant message
	const updated = [...messages];
	const message = { ...updated[index] };
	message.parts = applyEventToParts(message.parts ?? [], event);

	// Update status
	if (event.type === "text") {
		message.status = "streaming";
	} else if (event.type === "done") {
		message.status = "complete";
	} else if (event.type === "interrupted") {
		message.status = "interrupted";
	} else if (event.type === "error") {
		message.status = "error";
		message.error = event.error;
	}

	updated[index] = message;
	return updated;
}

// Finalize any incomplete assistant message and add user message + new assistant
function applyUserMessage(messages: Message[], content: string): Message[] {
	// Finalize any streaming assistant
	const finalized = messages.map((m) =>
		m.status === "sending" || m.status === "streaming"
			? { ...m, status: "complete" as const }
			: m,
	);

	// Add user message
	const userMessage: Message = {
		id: generateUUID(),
		role: "user",
		content,
		status: "complete",
		createdAt: new Date(),
	};

	// Add empty assistant message
	const assistantMessage = createAssistantMessage();

	return [...finalized, userMessage, assistantMessage];
}

interface Props {
	sessionId: string;
	sessionTitle: string;
	onUpdateTitle: (title: string) => void;
	onLogout?: () => void;
	onOpenSidebar?: () => void;
}

const STATUS_CONFIG: Record<ConnectionStatus, { text: string; color: string }> =
	{
		connected: { text: "Connected", color: "text-green-400" },
		error: { text: "Connection Error", color: "text-red-400" },
		disconnected: { text: "Disconnected", color: "text-yellow-400" },
		connecting: { text: "Connecting...", color: "text-yellow-400" },
	};

function ChatPanel({
	sessionId,
	sessionTitle,
	onUpdateTitle,
	onLogout,
	onOpenSidebar,
}: Props) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);

	const [isLoadingHistory, setIsLoadingHistory] = useState(false);

	// Load history when session changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally loading history when sessionId prop changes
	useEffect(() => {
		setMessages([]);
		setPermissionRequest(null);

		async function loadHistory() {
			setIsLoadingHistory(true);
			try {
				const history = await getHistory(sessionId);
				replayHistory(history);
			} catch (err) {
				console.error("Failed to load history:", err);
			} finally {
				setIsLoadingHistory(false);
			}
		}

		loadHistory();
	}, [sessionId]);

	// Replay historical records to rebuild message state
	const replayHistory = useCallback((records: unknown[]) => {
		let messages: Message[] = [];

		for (const record of records) {
			const event = normalizeEvent(record as Record<string, unknown>);

			if (event.type === "message" && event.content) {
				messages = applyUserMessage(messages, event.content);
			} else {
				messages = applyServerEvent(messages, event);
			}
		}

		setMessages(messages);
	}, []);

	const handleServerMessage = useCallback((serverMsg: WSServerMessage) => {
		// Handle permission request (not stored in history, UI-only)
		if (serverMsg.type === "permission_request") {
			setPermissionRequest({
				requestId: serverMsg.request_id,
				toolName: serverMsg.tool_name,
				toolInput: serverMsg.tool_input,
				toolUseId: serverMsg.tool_use_id,
			});
			return;
		}

		const event = normalizeEvent(serverMsg);
		setMessages((prev) => applyServerEvent(prev, event));
	}, []);

	const { status, send } = useWebSocket({
		onMessage: handleServerMessage,
	});

	const handleSend = useCallback(
		(content: string) => {
			const userMessageId = generateUUID();
			const assistantMessageId = generateUUID();

			// Update session title on first message
			if (sessionTitle === "New Chat") {
				const title =
					content.length > 30
						? `${content.slice(0, 30).replace(/\n/g, " ")}...`
						: content.replace(/\n/g, " ");
				onUpdateTitle(title);
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
				session_id: sessionId,
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
		[send, sessionId, sessionTitle, onUpdateTitle],
	);

	const handlePermissionResponse = useCallback(
		(allow: boolean) => {
			if (!permissionRequest) return;

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
				<div className="flex items-center gap-3">
					{onOpenSidebar && (
						<button
							type="button"
							onClick={onOpenSidebar}
							className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white"
							aria-label="Open menu"
						>
							<svg
								className="h-6 w-6"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								aria-hidden="true"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M4 6h16M4 12h16M4 18h16"
								/>
							</svg>
						</button>
					)}
					<h1 className="text-xl font-bold text-white">Pockode</h1>
				</div>
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
				disabled={status !== "connected" || isLoadingHistory}
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
