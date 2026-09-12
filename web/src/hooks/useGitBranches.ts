import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { gitBranchesQueryKey, invalidateGitQueries } from "./gitQueries";

export function useGitBranches() {
	const getBranches = useWSStore((state) => state.actions.getBranches);

	return useQuery({
		queryKey: gitBranchesQueryKey,
		queryFn: getBranches,
		// Kept fresh by git.changed rather than by expiry, like the status query.
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * Switching to a branch and creating one both move HEAD, so they invalidate the
 * whole panel rather than only the branch list.
 */
export function useGitBranchActions() {
	const queryClient = useQueryClient();
	const checkout = useWSStore((s) => s.actions.checkout);
	const createBranch = useWSStore((s) => s.actions.createBranch);

	// Deliberately not returned: react-query would fold the refetch into the
	// mutation's outcome, and the branch sheet would report a switch that did
	// happen as a failure because the refresh behind it failed.
	const onSuccess = () => {
		invalidateGitQueries(queryClient);
	};

	const checkoutMutation = useMutation({ mutationFn: checkout, onSuccess });
	const createMutation = useMutation({ mutationFn: createBranch, onSuccess });

	return { checkoutMutation, createMutation };
}
