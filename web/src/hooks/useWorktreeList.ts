import { useQuery } from "@tanstack/react-query";
import { fetchWorktrees, WORKTREES_QUERY_KEY } from "../lib/worktreeQuery";
import { useIsGitRepo } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";
import type { WorktreeInfo } from "../types/message";

/**
 * The worktrees that exist, for a reader that only wants to *name* one.
 *
 * `useWorktree` is the owner — it subscribes, creates, deletes and redirects —
 * and calling it a third time to read a list would install that machinery a
 * third time. This shares its cache entry and nothing else.
 */
export function useWorktreeList(): WorktreeInfo[] {
	const isConnected = useWSStore((s) => s.status === "connected");
	const isGitRepo = useIsGitRepo();
	const { data = [] } = useQuery({
		queryKey: WORKTREES_QUERY_KEY,
		queryFn: fetchWorktrees,
		enabled: isConnected && isGitRepo,
		staleTime: Number.POSITIVE_INFINITY,
	});
	return data;
}
