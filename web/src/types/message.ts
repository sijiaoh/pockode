// Session metadata
export interface SessionMeta {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
}

// Message role
export type MessageRole = "user" | "assistant";

// Message status
export type MessageStatus =
	| "sending"
	| "streaming"
	| "complete"
	| "error"
	| "interrupted"
	| "process_ended";

// Tool call
export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
	result?: string;
}

// Content part - represents a piece of content in timeline order
export type ContentPart =
	| { type: "text"; content: string }
	| { type: "tool_call"; tool: ToolCall }
	| { type: "system"; content: string };

// Chat message
export interface Message {
	id: string;
	role: MessageRole;
	content: string; // For user messages; for assistant, use parts
	parts?: ContentPart[]; // Timeline-ordered content for assistant
	status: MessageStatus;
	error?: string;
	createdAt: Date;
}

// Permission request
export interface PermissionRequest {
	requestId: string;
	toolName: string;
	toolInput: unknown;
	toolUseId: string;
}

// WebSocket client message
export type WSClientMessage =
	| {
			type: "message";
			content: string;
			session_id: string;
	  }
	| {
			type: "interrupt";
			session_id: string;
	  }
	| {
			type: "permission_response";
			session_id: string;
			request_id: string;
			allow: boolean;
	  };

// WebSocket server message
export type WSServerMessage =
	| { type: "text"; content: string }
	| {
			type: "tool_call";
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
	  }
	| { type: "tool_result"; tool_use_id: string; tool_result: string }
	| { type: "error"; error: string }
	| { type: "done" }
	| { type: "interrupted" }
	| { type: "process_ended" }
	| {
			type: "permission_request";
			request_id: string;
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
	  }
	| { type: "system"; content: string };
