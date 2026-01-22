import type { JSONRPCRequester } from "json-rpc-2.0";
import type { GitStatus } from "../../types/git";

export interface GitActions {
	getStatus: () => Promise<GitStatus>;
}

export function createGitActions(
	getClient: () => JSONRPCRequester<void> | null,
): GitActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		getStatus: async (): Promise<GitStatus> => {
			return requireClient().request("git.status", {});
		},
	};
}
