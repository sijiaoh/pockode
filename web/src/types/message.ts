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

// Question status
export type QuestionStatus = "pending" | "answered" | "cancelled";

// Content part - represents a piece of content in timeline order
export type ContentPart =
	| { type: "text"; content: string }
	| { type: "tool_call"; tool: ToolCall }
	| { type: "system"; content: string }
	| { type: "warning"; message: string; code: string }
	| {
			type: "permission_request";
			request: PermissionRequest;
			status: PermissionStatus;
	  }
	| {
			type: "ask_user_question";
			request: AskUserQuestionRequest;
			status: QuestionStatus;
			answers?: Record<string, string>;
	  }
	| { type: "raw"; content: string };

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
	toolUseId: string;
	questions: AskUserQuestion[];
}

// JSON-RPC 2.0 Request Params (Client → Server)

export interface AuthParams {
	token: string;
}

export interface AuthResult {
	version: string;
	title: string;
	work_dir: string;
}

export interface AttachParams {
	session_id: string;
}

export interface AttachResult {
	process_running: boolean;
}

export interface MessageParams {
	session_id: string;
	content: string;
}

export interface InterruptParams {
	session_id: string;
}

export interface PermissionResponseParams {
	session_id: string;
	request_id: string;
	tool_use_id: string;
	tool_input: unknown;
	permission_suggestions?: PermissionUpdate[];
	choice: "deny" | "allow" | "always_allow";
}

export interface QuestionResponseParams {
	session_id: string;
	request_id: string;
	tool_use_id: string;
	answers: Record<string, string> | null; // null = cancel
}

// Session management RPC params

export interface SessionDeleteParams {
	session_id: string;
}

export interface SessionUpdateTitleParams {
	session_id: string;
	title: string;
}

export interface SessionGetHistoryParams {
	session_id: string;
}

export interface SessionListResult {
	sessions: SessionMeta[];
}

export interface SessionGetHistoryResult {
	history: unknown[];
}

// JSON-RPC 2.0 Notification Params (Server → Client)

export interface TextNotification {
	session_id: string;
	content: string;
}

export interface ToolCallNotification {
	session_id: string;
	tool_name: string;
	tool_input: unknown;
	tool_use_id: string;
}

export interface ToolResultNotification {
	session_id: string;
	tool_use_id: string;
	tool_result: string;
}

export interface ErrorNotification {
	session_id: string;
	error: string;
}

export interface SessionNotification {
	session_id: string;
}

export interface PermissionRequestNotification {
	session_id: string;
	request_id: string;
	tool_name: string;
	tool_input: unknown;
	tool_use_id: string;
	permission_suggestions?: PermissionUpdate[];
}

export interface AskUserQuestionNotification {
	session_id: string;
	request_id: string;
	tool_use_id: string;
	questions: AskUserQuestion[];
}

export interface RequestCancelledNotification {
	session_id: string;
	request_id: string;
}

export interface SystemNotification {
	session_id: string;
	content: string;
}

// Server notification event types
export type ServerMethod =
	| "text"
	| "tool_call"
	| "tool_result"
	| "warning"
	| "error"
	| "done"
	| "interrupted"
	| "process_ended"
	| "permission_request"
	| "ask_user_question"
	| "request_cancelled"
	| "system";

// Server notification with type field for discriminated union
export type ServerNotification =
	| { type: "text"; session_id: string; content: string }
	| {
			type: "tool_call";
			session_id: string;
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
	  }
	| {
			type: "tool_result";
			session_id: string;
			tool_use_id: string;
			tool_result: string;
	  }
	| {
			type: "warning";
			session_id: string;
			message: string;
			code: string;
	  }
	| { type: "error"; session_id: string; error: string }
	| { type: "done"; session_id: string }
	| { type: "interrupted"; session_id: string }
	| { type: "process_ended"; session_id: string }
	| {
			type: "permission_request";
			session_id: string;
			request_id: string;
			tool_name: string;
			tool_input: unknown;
			tool_use_id: string;
			permission_suggestions?: PermissionUpdate[];
	  }
	| {
			type: "ask_user_question";
			session_id: string;
			request_id: string;
			tool_use_id: string;
			questions: AskUserQuestion[];
	  }
	| {
			type: "request_cancelled";
			session_id: string;
			request_id: string;
	  }
	| { type: "system"; session_id: string; content: string };
