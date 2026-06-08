import type { JSONRPCClient } from "json-rpc-2.0";
import type {
	Node,
	NodeCreateParams,
	NodeUpdateParams,
} from "../../types/node";

export interface NodeActions {
	listNodes: () => Promise<Node[]>;
	getNode: (id: string) => Promise<Node>;
	createNode: (params: NodeCreateParams) => Promise<Node>;
	updateNode: (params: NodeUpdateParams) => Promise<Node>;
	deleteNode: (id: string) => Promise<void>;
}

export function createNodeActions(
	getClient: () => JSONRPCClient | null,
): NodeActions {
	const requireClient = (): JSONRPCClient => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		listNodes: async (): Promise<Node[]> => {
			return requireClient().request("node.list", {});
		},

		getNode: async (id: string): Promise<Node> => {
			return requireClient().request("node.get", { id });
		},

		createNode: async (params: NodeCreateParams): Promise<Node> => {
			return requireClient().request("node.create", params);
		},

		updateNode: async (params: NodeUpdateParams): Promise<Node> => {
			return requireClient().request("node.update", params);
		},

		deleteNode: async (id: string): Promise<void> => {
			await requireClient().request("node.delete", { id });
		},
	};
}
