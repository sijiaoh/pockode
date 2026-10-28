import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsGitRepo } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";
import { gitBranchesQueryKey, invalidateGitQueries } from "./gitQueries";

export function useGitBranches() {
	const getBranches = useWSStore((state) => state.actions.getBranches);
	const isGitRepo = useIsGitRepo();

	return useQuery({
		queryKey: gitBranchesQueryKey,
		queryFn: getBranches,
		enabled: isGitRepo === true,
		// Kept fresh by git.changed rather than by expiry, like the status query.
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * Switching to a branch and creating one both move HEAD, so they invalidate the
 * whole panel rather than only the branch list. Deleting a branch never touches
 * HEAD, so it refreshes the list alone.
 */
export function useGitBranchActions() {
	const queryClient = useQueryClient();
	const checkout = useWSStore((s) => s.actions.checkout);
	const createBranch = useWSStore((s) => s.actions.createBranch);
	const deleteBranch = useWSStore((s) => s.actions.deleteBranch);

	// Deliberately not returned: react-query would fold the refetch into the
	// mutation's outcome, and the Branches list would report a switch that did
	// happen as a failure because the refresh behind it failed.
	const onSuccess = () => {
		invalidateGitQueries(queryClient);
	};

	const checkoutMutation = useMutation({ mutationFn: checkout, onSuccess });
	const createMutation = useMutation({ mutationFn: createBranch, onSuccess });
	const deleteMutation = useMutation({
		mutationFn: ({ name, tip }: { name: string; tip: string }) =>
			deleteBranch(name, tip),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: gitBranchesQueryKey });
		},
	});

	return { checkoutMutation, createMutation, deleteMutation };
}
