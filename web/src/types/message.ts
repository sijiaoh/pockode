// Message role
export type MessageRole = "user" | "assistant";

// Message status
export type MessageStatus = "sending" | "streaming" | "complete" | "error";

// Tool call
export interface ToolCall {
	name: string;
	input: unknown;
	result?: string;
}

// Chat message
export interface Message {
	id: string;
	role: MessageRole;
	content: string;
	status: MessageStatus;
	toolCalls?: ToolCall[];
	error?: string;
	createdAt: Date;
}

// WebSocket client message
export interface WSClientMessage {
	type: "message" | "cancel";
	id: string;
	content: string;
}

// WebSocket server message
export interface WSServerMessage {
	type: "text" | "tool_call" | "tool_result" | "error" | "done";
	message_id: string;
	content?: string;
	tool_name?: string;
	tool_input?: unknown;
	error?: string;
}
