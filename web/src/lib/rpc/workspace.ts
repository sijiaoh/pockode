import type { JSONRPCRequester } from "json-rpc-2.0";
import type { Workspace } from "../workspaceStore";

export interface WorkspaceActions {
	getWorkspaces: () => Promise<Workspace[]>;
	createWorkspace: (name: string, path: string) => Promise<Workspace>;
	updateWorkspace: (id: string, name: string) => Promise<Workspace>;
	deleteWorkspace: (id: string) => Promise<void>;
}

export function createWorkspaceActions(
	getClient: () => JSONRPCRequester<void> | null,
): WorkspaceActions {
	return {
		getWorkspaces: async () => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = await client.request("workspace.list", {});
			return (result as { workspaces: Workspace[] }).workspaces;
		},

		createWorkspace: async (name: string, path: string) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = await client.request("workspace.add", { name, path });
			return result as Workspace;
		},

		updateWorkspace: async (id: string, name: string) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = await client.request("workspace.update", { id, name });
			return result as Workspace;
		},

		deleteWorkspace: async (id: string) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			await client.request("workspace.remove", { id });
		},
	};
}
