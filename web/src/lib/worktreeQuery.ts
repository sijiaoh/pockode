import type { WorktreeInfo } from "../types/message";
import { worktreeActions } from "./worktreeStore";
import { wsActions } from "./wsStore";

/** Cache entry shared by every reader of the worktree list. */
export const WORKTREES_QUERY_KEY = ["worktrees"];

/**
 * Fetcher behind WORKTREES_QUERY_KEY. Lives next to the key so the two cannot
 * drift: readers that share a cache entry must also share its shape.
 */
export async function fetchWorktrees({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<WorktreeInfo[]> {
	const result = await wsActions.listWorktrees();
	// The server answers out of order, so a reply to a request that
	// worktree.changed has since cancelled can land after the newer answer. Its
	// list is discarded by the query; its store writes must be as well.
	if (signal?.aborted) return result.worktrees;
	// Whether the setup script can run is a property of the server's machine, not
	// of any single worktree, so it lives in the store rather than the list.
	worktreeActions.setSetupHookSkip(result.setup_hook_skip ?? null);
	worktreeActions.setIsGitRepo(result.is_git_repo);
	return result.worktrees;
}
