import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { gitCommitQueryKey } from "./gitQueries";

export function useGitCommit(hash: string | null) {
	const getCommit = useWSStore((state) => state.actions.getCommit);

	return useQuery({
		queryKey: [...gitCommitQueryKey, hash],
		queryFn: () => {
			if (!hash) throw new Error("Hash is required");
			return getCommit(hash);
		},
		enabled: !!hash,
	});
}

/**
 * A commit's subject alone, for naming it beside another — a parent on a
 * commit's page. Under a key of its own, outside `gitCommitQueryKey`: a
 * subject never changes, so `git.changed` has nothing to re-read here.
 */
export function useGitCommitSubject(hash: string) {
	const getCommit = useWSStore((state) => state.actions.getCommit);

	return useQuery({
		queryKey: ["git-commit-subject", hash],
		queryFn: () => getCommit(hash),
		select: (commit) => commit.subject,
		staleTime: Number.POSITIVE_INFINITY,
	});
}
