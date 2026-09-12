import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { invalidateGitQueries } from "./gitQueries";

/**
 * Records a commit. (`useGitCommit` reads one; this one writes.)
 *
 * Committing empties the index and moves HEAD, so it refreshes the whole panel:
 * the staged list, the history and the branch bar's ahead count all change at
 * once.
 */
export function useGitCreateCommit() {
	const queryClient = useQueryClient();
	const commit = useWSStore((s) => s.actions.commit);

	return useMutation({
		mutationFn: ({ message, amend }: { message: string; amend: boolean }) =>
			commit(message, amend),
		// Deliberately not returned: react-query would fold the refetch into the
		// mutation's outcome, and the commit sheet would report a commit that did
		// happen as a failure because the refresh behind it failed.
		onSuccess: () => {
			invalidateGitQueries(queryClient);
		},
	});
}
