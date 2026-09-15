import { useMutation, useQueryClient } from "@tanstack/react-query";
import { gitSyncActions } from "../lib/gitSyncStore";
import { useWorktreeStore } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";
import type { GitSync } from "../types/git";
import {
	FETCH_FAILURE,
	FETCH_SUCCESS,
	pullFailureSummary,
	pullSuccess,
	pushFailureSummary,
	pushSuccess,
} from "../utils/gitSyncMessages";
import { invalidateGitQueries } from "./gitQueries";

/**
 * Fetch, pull and push.
 *
 * All three change what the panel reads — pull moves HEAD, push and fetch move
 * the counts — so each refreshes the whole panel rather than only the branch
 * list. The sync state itself rides along with the branch query, so there is no
 * query key of its own here.
 */
function useGitSyncActions() {
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

/**
 * The three operations as the panel starts them: through the sync store, so
 * that the run and its outcome survive the sync sheet closing behind them.
 *
 * Unmounting mid-run costs nothing here — react-query invokes the mutation's
 * own onSuccess rather than the observer's, so the panel still refreshes.
 */
export function useGitSyncRunner() {
	const worktree = useWorktreeStore((s) => s.current);
	const { fetchMutation, pullMutation, pushMutation } = useGitSyncActions();

	return {
		startFetch: () =>
			gitSyncActions.start(
				worktree,
				"fetch",
				async () => {
					await fetchMutation.mutateAsync();
					return FETCH_SUCCESS;
				},
				() => FETCH_FAILURE,
			),

		startPull: () =>
			gitSyncActions.start(
				worktree,
				"pull",
				async () => pullSuccess(await pullMutation.mutateAsync()),
				pullFailureSummary,
			),

		// sync comes from the caller, which is showing the very counts the
		// sentence reports; by the time the push settles they have been
		// invalidated.
		startPush: (sync: GitSync, force: boolean) =>
			gitSyncActions.start(
				worktree,
				"push",
				async () => {
					await pushMutation.mutateAsync(force);
					return pushSuccess(sync);
				},
				pushFailureSummary,
			),
	};
}
