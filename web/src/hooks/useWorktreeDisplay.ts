import { useQuery } from "@tanstack/react-query";
import { getDisplayName, useIsGitRepo } from "../lib/worktreeStore";
import { useWSStore, wsActions } from "../lib/wsStore";

export interface WorktreeDisplay {
	displayName: string;
	isMain: boolean;
}

/**
 * Resolves a work's `worktree` field into a display name.
 *
 * - Non-empty → a feature worktree; the stored name is the display name
 *   directly, so it renders even if the worktree was later deleted.
 * - Empty → the main worktree; the display name is the main branch (matching
 *   WorktreeSwitcher), falling back to a neutral "Default" until the list loads.
 */
export function useWorktreeDisplay(
	worktree: string | undefined,
): WorktreeDisplay {
	const isConnected = useWSStore((s) => s.status === "connected");
	const isGitRepo = useIsGitRepo();

	// Only the main path needs the list; feature worktrees display their stored
	// name directly. Shares the react-query cache with useWorktree (same key);
	// read-only here, live updates are driven by its subscription elsewhere.
	const { data: worktrees = [] } = useQuery({
		queryKey: ["worktrees"],
		queryFn: () => wsActions.listWorktrees(),
		enabled: !worktree && isConnected && isGitRepo,
		staleTime: Number.POSITIVE_INFINITY,
	});

	if (worktree) {
		return { displayName: worktree, isMain: false };
	}

	const main = worktrees.find((w) => w.is_main);
	return { displayName: main ? getDisplayName(main) : "Default", isMain: true };
}
