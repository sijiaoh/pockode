export interface AgentRole {
	id: string;
	name: string;
	role_prompt: string;
	steps?: string[];
	created_at: string;
	updated_at: string;
}

export interface AgentRoleCreateParams {
	name: string;
	role_prompt: string;
	steps?: string[];
}

export interface AgentRoleUpdateParams {
	id: string;
	name?: string;
	role_prompt?: string;
	steps?: string[];
}

export interface AgentRoleListSubscribeResult {
	id: string;
	items: AgentRole[];
}

export type AgentRoleListChangedNotification =
	| { id: string; operation: "create" | "update"; role: AgentRole }
	| { id: string; operation: "delete"; roleId: string }
	| { id: string; operation: "sync"; roles: AgentRole[] };
