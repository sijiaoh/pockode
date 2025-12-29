// Session metadata
export interface SessionMeta {
	id: string;
	title: string;
	created_at: string;
	updated_at: string;
}

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

// Permission request status
export type PermissionStatus = "pending" | "allowed" | "denied";

// Content part - represents a piece of content in timeline order
export type ContentPart =
	| { type: "text"; content: string }
	| { type: "tool_call"; tool: ToolCall }
	| { type: "system"; content: string }
	| {
			type: "permission_request";
			request: PermissionRequest;
			status: PermissionStatus;
	  };

// User message - plain text content
export interface UserMessage {
	id: string;
	role: "user";
	content: string;
	status: MessageStatus;
	createdAt: Date;
}

// Assistant message - structured parts (text, tool calls, system)
export interface AssistantMessage {
	id: string;
	role: "assistant";
	parts: ContentPart[];
	status: MessageStatus;
	error?: string;
	createdAt: Date;
}

// Discriminated union by role
export type Message = UserMessage | AssistantMessage;

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionUpdateDestination =
	| "userSettings"
	| "projectSettings"
	| "localSettings"
	| "session";

export interface PermissionRuleValue {
	toolName: string;
	ruleContent?: string;
}

export type PermissionUpdate =
	| {
			type: "addRules";
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "replaceRules";
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "removeRules";
			rules: PermissionRuleValue[];
			behavior: PermissionBehavior;
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "setMode";
			mode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "addDirectories";
			directories: string[];
			destination: PermissionUpdateDestination;
	  }
	| {
			type: "removeDirectories";
			directories: string[];
			destination: PermissionUpdateDestination;
	  };

export interface PermissionRequest {
	requestId: string;
	toolName: string;
	toolInput: unknown;
	toolUseId: string;
	permissionSuggestions?: PermissionUpdate[];
}

// AskUserQuestion types
export interface QuestionOption {
	label: string;
	description: string;
}

export interface AskUserQuestion {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect: boolean;
}

export interface AskUserQuestionRequest {
	requestId: string;
	questions: AskUserQuestion[];
}

// WebSocket client message
export type WSClientMessage =
	| {
			type: "attach";
			session_id: string;
	  }
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
			choice: "deny" | "allow" | "always_allow";
	  }
	| {
			type: "question_response";
			session_id: string;
			request_id: string;
			answers: Record<string, string> | null; // null = cancel
	  };

// Base interface for all server messages
interface WSServerMessageBase {
	session_id?: string;
}

// WebSocket server message
export type WSServerMessage =
	| (WSServerMessageBase & { type: "text"; content: string })
	| (WSServerMessageBase & {
			type: "tool_call";
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
	  })
	| (WSServerMessageBase & {
			type: "tool_result";
			tool_use_id: string;
			tool_result: string;
	  })
	| (WSServerMessageBase & { type: "error"; error: string })
	| (WSServerMessageBase & { type: "done" })
	| (WSServerMessageBase & { type: "interrupted" })
	| (WSServerMessageBase & { type: "process_ended" })
	| (WSServerMessageBase & {
			type: "permission_request";
			request_id: string;
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
			permission_suggestions?: PermissionUpdate[];
	  })
	| (WSServerMessageBase & {
			type: "ask_user_question";
			request_id: string;
			questions: AskUserQuestion[];
	  })
	| (WSServerMessageBase & { type: "system"; content: string });
