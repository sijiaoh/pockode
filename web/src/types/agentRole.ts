import type { AgentType } from "./settings";

export interface AgentRole {
	id: string;
	name: string;
	role_prompt: string;
	steps?: string[];
	/** Absent means the role follows the default agent type from Settings. */
	agent_type?: AgentType;
	/** Absent means Auto — no `--model` is passed and the CLI decides. */
	model?: string;
	/** Absent means Auto — the CLI keeps its own default. */
	effort?: string;
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
	/**
	 * Empty string clears the agent type back to following Settings. The server
	 * clears `model` and `effort` along with any change to this field, so the
	 * caller sends one field rather than three.
	 */
	agent_type?: AgentType | "";
	model?: string;
	effort?: string;
}

export interface AgentRoleListSubscribeResult {
	items: AgentRole[];
	/**
	 * How many work items name each role, keyed by role id. A role missing from
	 * the map is referenced by nothing.
	 *
	 * It is not a field on the role because it is not the role's: it comes from
	 * the work store and moves when no role has changed, so it arrives on its
	 * own `ref_counts` notification, always as the whole map.
	 */
	work_ref_counts: Record<string, number>;
}

export type AgentRoleListChangedNotification =
	| { id: string; operation: "create" | "update"; role: AgentRole }
	| { id: string; operation: "delete"; roleId: string }
	| { id: string; operation: "sync"; roles: AgentRole[] }
	| {
			id: string;
			operation: "ref_counts";
			work_ref_counts: Record<string, number>;
	  };
