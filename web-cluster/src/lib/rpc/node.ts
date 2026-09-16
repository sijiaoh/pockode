import type { JSONRPCClient } from "json-rpc-2.0";
import type {
	Node,
	NodeCleanupParams,
	NodeCreateParams,
	NodeStartParams,
	NodeStatusInfo,
	NodeStopParams,
	NodeUpdateParams,
	NodeWithStatus,
} from "../../types/node";

export interface NodeActions {
	listNodes: () => Promise<NodeWithStatus[]>;
	getNode: (id: string) => Promise<NodeWithStatus>;
	createNode: (params: NodeCreateParams) => Promise<Node>;
	updateNode: (params: NodeUpdateParams) => Promise<Node>;
	deleteNode: (id: string) => Promise<void>;
	getNodeStatus: (id: string) => Promise<NodeStatusInfo>;
	startNode: (params: NodeStartParams) => Promise<NodeStatusInfo>;
	stopNode: (params: NodeStopParams) => Promise<NodeStatusInfo>;
	cleanupNode: (params: NodeCleanupParams) => Promise<NodeStatusInfo>;
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
		listNodes: async (): Promise<NodeWithStatus[]> => {
			return requireClient().request("node.list", {});
		},

		getNode: async (id: string): Promise<NodeWithStatus> => {
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

		getNodeStatus: async (id: string): Promise<NodeStatusInfo> => {
			return requireClient().request("node.status", { id });
		},

		startNode: async (params: NodeStartParams): Promise<NodeStatusInfo> => {
			return requireClient().request("node.start", params);
		},

		stopNode: async (params: NodeStopParams): Promise<NodeStatusInfo> => {
			return requireClient().request("node.stop", params);
		},

		// Deletes a stale `server.json` and answers with the fresh status. It is
		// idempotent, and refuses (`node is still running`) rather than orphaning a
		// live server — so unlike the `node.stop` call this replaces, a success here
		// means what the button said.
		cleanupNode: async (params: NodeCleanupParams): Promise<NodeStatusInfo> => {
			return requireClient().request("node.cleanup", params);
		},
	};
}
