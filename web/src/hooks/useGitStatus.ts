import { useQuery } from "@tanstack/react-query";
import { useIsGitRepo } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";
import { gitStatusQueryKey } from "./gitQueries";

export function useGitStatus() {
	const getStatus = useWSStore((state) => state.actions.getStatus);
	// Gated here rather than by the caller: the sidebar's count badge reads it
	// while no Git tab is mounted, and a git.changed can outrun the
	// worktree.changed that unmounts the tab. Outside a repository the read can
	// only fail.
	const isGitRepo = useIsGitRepo();

	return useQuery({
		queryKey: gitStatusQueryKey,
		queryFn: getStatus,
		enabled: isGitRepo === true,
		staleTime: Number.POSITIVE_INFINITY,
	});
}
