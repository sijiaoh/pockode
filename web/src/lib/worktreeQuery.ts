import type { WorktreeInfo } from "../types/message";
import { worktreeActions } from "./worktreeStore";
import { wsActions } from "./wsStore";

/** Cache entry shared by every reader of the worktree list. */
export const WORKTREES_QUERY_KEY = ["worktrees"];

/**
 * Fetcher behind WORKTREES_QUERY_KEY. Lives next to the key so the two cannot
 * drift: readers that share a cache entry must also share its shape.
 */
export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
	const result = await wsActions.listWorktrees();
	// Whether the setup script can run is a property of the server's machine, not
	// of any single worktree, so it lives in the store rather than the list.
	worktreeActions.setSetupHookSkip(result.setup_hook_skip ?? null);
	return result.worktrees;
}
