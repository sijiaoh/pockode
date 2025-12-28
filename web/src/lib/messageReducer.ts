import type { ContentPart, Message, WSServerMessage } from "../types/message";
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
	| { type: "message"; content: string }; // For history replay (user message)

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
		default:
			// Fallback for unknown types - treat as text
			return { type: "text", content: "" };
	}
}

export function applyEventToParts(
	parts: ContentPart[],
	event: NormalizedEvent,
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
		default:
			return parts;
	}
}

export function createAssistantMessage(
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

// Shared by history replay and real-time streaming
export function applyServerEvent(
	messages: Message[],
	event: NormalizedEvent,
): Message[] {
	// System messages are always standalone
	if (event.type === "system") {
		const systemMessage = createAssistantMessage("complete");
		systemMessage.parts = [{ type: "system", content: event.content }];
		return [...messages, systemMessage];
	}

	// Find current assistant (sending or streaming)
	let index = messages.findIndex(
		(m) => m.status === "sending" || m.status === "streaming",
	);

	// No current assistant? Create one to hold the orphan event
	let updated: Message[];
	if (index === -1) {
		updated = [...messages, createAssistantMessage()];
		index = updated.length - 1;
	} else {
		updated = [...messages];
	}

	const message = { ...updated[index] };
	message.parts = applyEventToParts(message.parts ?? [], event);

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
	const finalized = messages.map((m) =>
		m.status === "sending" || m.status === "streaming"
			? { ...m, status: "complete" as const }
			: m,
	);

	const userMessage: Message = {
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
			messages = applyServerEvent(messages, event);
		}
	}

	return messages;
}
