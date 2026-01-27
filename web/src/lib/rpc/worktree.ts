import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	WorktreeCreateParams,
	WorktreeDeleteParams,
	WorktreeInfo,
	WorktreeListResult,
} from "../../types/message";

export interface WorktreeActions {
	listWorktrees: () => Promise<WorktreeInfo[]>;
	createWorktree: (
		name: string,
		branch: string,
		baseBranch?: string,
	) => Promise<void>;
	deleteWorktree: (name: string) => Promise<void>;
}

export function createWorktreeActions(
	getClient: () => JSONRPCRequester<void> | null,
): WorktreeActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		listWorktrees: async (): Promise<WorktreeInfo[]> => {
			const result: WorktreeListResult = await requireClient().request(
				"worktree.list",
				{},
			);
			return result.worktrees;
		},

		createWorktree: async (
			name: string,
			branch: string,
			baseBranch?: string,
		): Promise<void> => {
			const params: WorktreeCreateParams = { name, branch };
			if (baseBranch) {
				params.base_branch = baseBranch;
			}
			await requireClient().request("worktree.create", params);
		},

		deleteWorktree: async (name: string): Promise<void> => {
			const params: WorktreeDeleteParams = { name };
			await requireClient().request("worktree.delete", params);
		},
	};
}
