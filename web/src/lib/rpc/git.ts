import type { JSONRPCRequester } from "json-rpc-2.0";
import type { GitLogResult, GitShowResult, GitStatus } from "../../types/git";

export interface GitActions {
	getStatus: () => Promise<GitStatus>;
	getLog: (limit?: number) => Promise<GitLogResult>;
	getCommit: (hash: string) => Promise<GitShowResult>;
	stage: (paths: string[]) => Promise<void>;
	unstage: (paths: string[]) => Promise<void>;
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
		getLog: async (limit?: number): Promise<GitLogResult> => {
			return requireClient().request("git.log", { limit: limit ?? 50 });
		},
		getCommit: async (hash: string): Promise<GitShowResult> => {
			return requireClient().request("git.show", { hash });
		},
		stage: async (paths: string[]): Promise<void> => {
			await requireClient().request("git.add", { paths });
		},
		unstage: async (paths: string[]): Promise<void> => {
			await requireClient().request("git.reset", { paths });
		},
	};
}
