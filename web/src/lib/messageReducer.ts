import type {
	AssistantMessage,
	ContentPart,
	Message,
	PermissionUpdate,
	UserMessage,
	WSServerMessage,
} from "../types/message";
import { generateUUID } from "../utils/uuid";

// Normalized event with camelCase (internal representation)
export type NormalizedEvent =
	| { type: "text"; content: string }
	| {
			type: "tool_call";
			toolUseId: string;
			toolName: string;
			toolInput: unknown;
	  }
	| { type: "tool_result"; toolUseId: string; toolResult: string }
	| { type: "error"; error: string }
	| { type: "done" }
	| { type: "interrupted" }
	| { type: "process_ended" }
	| { type: "system"; content: string }
	| { type: "message"; content: string } // For history replay (user message)
	| {
			type: "permission_request";
			requestId: string;
			toolName: string;
			toolInput: unknown;
			toolUseId: string;
			permissionSuggestions?: PermissionUpdate[];
	  };

// Convert snake_case server event to camelCase
export function normalizeEvent(
	e: WSServerMessage | Record<string, unknown>,
): NormalizedEvent {
	const record = e as Record<string, unknown>;
	const type = record.type as string;

	switch (type) {
		case "text":
			return { type: "text", content: (record.content as string) ?? "" };
		case "tool_call":
			return {
				type: "tool_call",
				toolUseId: record.tool_use_id as string,
				toolName: record.tool_name as string,
				toolInput: record.tool_input,
			};
		case "tool_result":
			return {
				type: "tool_result",
				toolUseId: record.tool_use_id as string,
				toolResult: (record.tool_result as string) ?? "",
			};
		case "error":
			return { type: "error", error: (record.error as string) ?? "" };
		case "done":
			return { type: "done" };
		case "interrupted":
			return { type: "interrupted" };
		case "process_ended":
			return { type: "process_ended" };
		case "system":
			return { type: "system", content: (record.content as string) ?? "" };
		case "message":
			return { type: "message", content: (record.content as string) ?? "" };
		case "permission_request":
			return {
				type: "permission_request",
				requestId: record.request_id as string,
				toolName: record.tool_name as string,
				toolInput: record.tool_input,
				toolUseId: record.tool_use_id as string,
				permissionSuggestions: record.permission_suggestions as
					| PermissionUpdate[]
					| undefined,
			};
		default:
			// Fallback for unknown types - treat as text
			return { type: "text", content: "" };
	}
}

export function applyEventToParts(
	parts: ContentPart[],
	event: NormalizedEvent,
	isReplay = false,
): ContentPart[] {
	switch (event.type) {
		case "text": {
			const lastPart = parts[parts.length - 1];
			if (lastPart?.type === "text") {
				return [
					...parts.slice(0, -1),
					{ type: "text", content: lastPart.content + event.content },
				];
			}
			return [...parts, { type: "text", content: event.content }];
		}
		case "tool_call":
			return [
				...parts,
				{
					type: "tool_call",
					tool: {
						id: event.toolUseId,
						name: event.toolName,
						input: event.toolInput,
					},
				},
			];
		case "tool_result":
			return parts.map((part) =>
				part.type === "tool_call" && part.tool.id === event.toolUseId
					? { ...part, tool: { ...part.tool, result: event.toolResult } }
					: part,
			);
		case "permission_request":
			return [
				...parts,
				{
					type: "permission_request",
					request: {
						requestId: event.requestId,
						toolName: event.toolName,
						toolInput: event.toolInput,
						toolUseId: event.toolUseId,
						permissionSuggestions: event.permissionSuggestions,
					},
					status: isReplay ? "denied" : "pending",
				},
			];
		default:
			return parts;
	}
}

export function createAssistantMessage(
	status: AssistantMessage["status"] = "streaming",
): AssistantMessage {
	return {
		id: generateUUID(),
		role: "assistant",
		parts: [],
		status,
		createdAt: new Date(),
	};
}

// Shared by history replay and real-time streaming
export function applyServerEvent(
	messages: Message[],
	event: NormalizedEvent,
	isReplay = false,
): Message[] {
	// System messages are always standalone
	if (event.type === "system") {
		const systemMessage = createAssistantMessage("complete");
		systemMessage.parts = [{ type: "system", content: event.content }];
		return [...messages, systemMessage];
	}

	// Find current assistant (sending or streaming)
	let index = messages.findIndex(
		(m) =>
			m.role === "assistant" &&
			(m.status === "sending" || m.status === "streaming"),
	);

	// No current assistant? Create one to hold the orphan event
	let updated: Message[];
	if (index === -1) {
		updated = [...messages, createAssistantMessage()];
		index = updated.length - 1;
	} else {
		updated = [...messages];
	}

	const current = updated[index];
	if (current.role !== "assistant") {
		return updated; // Type guard - should never happen
	}

	const message: AssistantMessage = {
		...current,
		parts: applyEventToParts(current.parts, event, isReplay),
	};

	if (event.type === "text") {
		message.status = "streaming";
	} else if (event.type === "done") {
		message.status = "complete";
	} else if (event.type === "interrupted") {
		message.status = "interrupted";
	} else if (event.type === "error") {
		message.status = "error";
		message.error = event.error;
	} else if (event.type === "process_ended") {
		message.status = "process_ended";
	}

	updated[index] = message;
	return updated;
}

// Finalizes any streaming assistant before adding new user message
export function applyUserMessage(
	messages: Message[],
	content: string,
): Message[] {
	const finalized = messages.map((m): Message => {
		if (
			m.role === "assistant" &&
			(m.status === "sending" || m.status === "streaming")
		) {
			return { ...m, status: "complete" };
		}
		return m;
	});

	const userMessage: UserMessage = {
		id: generateUUID(),
		role: "user",
		content,
		status: "complete",
		createdAt: new Date(),
	};

	return [...finalized, userMessage, createAssistantMessage()];
}

export function replayHistory(records: unknown[]): Message[] {
	let messages: Message[] = [];

	for (const record of records) {
		const event = normalizeEvent(record as Record<string, unknown>);

		if (event.type === "message" && event.content) {
			messages = applyUserMessage(messages, event.content);
		} else {
			messages = applyServerEvent(messages, event, true);
		}
	}

	// Check if the last permission_request might still be pending
	// A permission_request is considered pending if:
	// 1. It's at the end of the last assistant message
	// 2. The message wasn't finalized (no done/error/interrupted after it)
	const lastMessage = messages.at(-1);
	if (
		lastMessage?.role === "assistant" &&
		(lastMessage.status === "streaming" || lastMessage.status === "sending")
	) {
		const lastPart = lastMessage.parts.at(-1);
		// Only the very last permission_request could be pending
		if (
			lastPart?.type === "permission_request" &&
			lastPart.status === "denied"
		) {
			const updatedParts = [
				...lastMessage.parts.slice(0, -1),
				{ ...lastPart, status: "pending" as const },
			];
			messages[messages.length - 1] = { ...lastMessage, parts: updatedParts };
		}
	}

	return messages;
}
