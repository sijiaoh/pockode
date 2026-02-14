import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	AgentRole,
	AgentRoleCreateParams,
	AgentRoleDeleteParams,
	AgentRoleListResult,
	AgentRoleUpdateParams,
} from "../../types/message";

export interface AgentRoleActions {
	listRoles: () => Promise<AgentRoleListResult>;
	createRole: (name: string, systemPrompt: string) => Promise<AgentRole>;
	updateRole: (
		roleId: string,
		name: string,
		systemPrompt: string,
	) => Promise<AgentRole>;
	deleteRole: (roleId: string) => Promise<void>;
}

export function createAgentRoleActions(
	getClient: () => JSONRPCRequester<void> | null,
): AgentRoleActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		listRoles: async (): Promise<AgentRoleListResult> => {
			return requireClient().request("agent.role.list", {});
		},

		createRole: async (
			name: string,
			systemPrompt: string,
		): Promise<AgentRole> => {
			return requireClient().request("agent.role.create", {
				name,
				system_prompt: systemPrompt,
			} as AgentRoleCreateParams);
		},

		updateRole: async (
			roleId: string,
			name: string,
			systemPrompt: string,
		): Promise<AgentRole> => {
			return requireClient().request("agent.role.update", {
				role_id: roleId,
				name,
				system_prompt: systemPrompt,
			} as AgentRoleUpdateParams);
		},

		deleteRole: async (roleId: string): Promise<void> => {
			await requireClient().request("agent.role.delete", {
				role_id: roleId,
			} as AgentRoleDeleteParams);
		},
	};
}
