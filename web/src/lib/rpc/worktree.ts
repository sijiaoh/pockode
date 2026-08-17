import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	WorktreeCreateParams,
	WorktreeCreateResult,
	WorktreeDeleteParams,
	WorktreeListResult,
} from "../../types/message";

export interface WorktreeActions {
	listWorktrees: () => Promise<WorktreeListResult>;
	createWorktree: (
		name: string,
		branch: string,
		baseBranch?: string,
	) => Promise<WorktreeCreateResult>;
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
		listWorktrees: async (): Promise<WorktreeListResult> => {
			return requireClient().request("worktree.list", {});
		},

		createWorktree: async (
			name: string,
			branch: string,
			baseBranch?: string,
		): Promise<WorktreeCreateResult> => {
			const params: WorktreeCreateParams = { name, branch };
			if (baseBranch) {
				params.base_branch = baseBranch;
			}
			return requireClient().request("worktree.create", params);
		},

		deleteWorktree: async (name: string): Promise<void> => {
			const params: WorktreeDeleteParams = { name };
			await requireClient().request("worktree.delete", params);
		},
	};
}
