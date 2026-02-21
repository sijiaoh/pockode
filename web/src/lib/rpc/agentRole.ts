import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	AgentRole,
	AgentRoleCreateParams,
	AgentRoleUpdateParams,
} from "../../types/agentRole";

export interface AgentRoleActions {
	createAgentRole: (params: AgentRoleCreateParams) => Promise<AgentRole>;
	updateAgentRole: (params: AgentRoleUpdateParams) => Promise<void>;
	deleteAgentRole: (id: string) => Promise<void>;
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
		createAgentRole: async (
			params: AgentRoleCreateParams,
		): Promise<AgentRole> => {
			return requireClient().request("agent_role.create", params);
		},
		updateAgentRole: async (params: AgentRoleUpdateParams): Promise<void> => {
			await requireClient().request("agent_role.update", params);
		},
		deleteAgentRole: async (id: string): Promise<void> => {
			await requireClient().request("agent_role.delete", { id });
		},
	};
}
