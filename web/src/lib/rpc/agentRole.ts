import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	AgentRole,
	AgentRoleCreateParams,
	AgentRoleUpdateParams,
} from "../../types/agentRole";
import { requireClient } from "./client";

export interface AgentRoleActions {
	createAgentRole: (params: AgentRoleCreateParams) => Promise<AgentRole>;
	updateAgentRole: (params: AgentRoleUpdateParams) => Promise<void>;
	deleteAgentRole: (id: string) => Promise<void>;
	resetAgentRoleDefaults: () => Promise<void>;
}

export function createAgentRoleActions(
	getClient: () => JSONRPCRequester<void> | null,
): AgentRoleActions {
	const client = () => requireClient(getClient);

	return {
		createAgentRole: async (
			params: AgentRoleCreateParams,
		): Promise<AgentRole> => {
			return client().request("agent_role.create", params);
		},
		updateAgentRole: async (params: AgentRoleUpdateParams): Promise<void> => {
			await client().request("agent_role.update", params);
		},
		deleteAgentRole: async (id: string): Promise<void> => {
			await client().request("agent_role.delete", { id });
		},
		resetAgentRoleDefaults: async (): Promise<void> => {
			await client().request("agent_role.reset_defaults", {});
		},
	};
}
