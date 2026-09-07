import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import { invalidateGitQueries } from "./gitQueries";

/**
 * Fetch, pull and push.
 *
 * All three change what the panel reads — pull moves HEAD, push and fetch move
 * the counts — so each refreshes the whole panel rather than only the branch
 * list. The sync state itself rides along with the branch query, so there is no
 * query key of its own here.
 */
export function useGitSyncActions() {
	const queryClient = useQueryClient();
	const fetchRemote = useWSStore((s) => s.actions.fetchRemote);
	const pull = useWSStore((s) => s.actions.pull);
	const push = useWSStore((s) => s.actions.push);

	// Deliberately not returned: react-query would fold the refetch into the
	// mutation's outcome, and the sync sheet would report a push that did happen
	// as a failure because the refresh behind it failed.
	const onSuccess = () => {
		invalidateGitQueries(queryClient);
	};

	const fetchMutation = useMutation({ mutationFn: fetchRemote, onSuccess });
	const pullMutation = useMutation({ mutationFn: pull, onSuccess });
	const pushMutation = useMutation({
		mutationFn: (force: boolean) => push(force),
		onSuccess,
	});

	return { fetchMutation, pullMutation, pushMutation };
}
