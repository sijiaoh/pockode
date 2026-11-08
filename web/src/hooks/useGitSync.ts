import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { gitSyncActions, useGitSyncStore } from "../lib/gitSyncStore";
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
import { shouldAutoFetch } from "../utils/gitSyncStatus";
import { invalidateGitQueries } from "./gitQueries";
import { useGitBranches } from "./useGitBranches";
import { useIsWorktreeSwitching } from "./useIsWorktreeSwitching";

/**
 * Fetch, pull and push.
 *
 * All three change what the workspace reads — pull moves HEAD, push and fetch move
 * the counts — so each refreshes the whole workspace rather than only the branch
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
 * The three operations as the workspace starts them: through the sync store, so
 * that the run and its outcome survive the sync sheet closing behind them.
 *
 * Unmounting mid-run costs nothing here — react-query invokes the mutation's
 * own onSuccess rather than the observer's, so the workspace still refreshes.
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

		startAutoFetch: () =>
			gitSyncActions.startAutoFetch(worktree, async () => {
				await fetchMutation.mutateAsync();
			}),

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

/**
 * Fetches once on the way into the Git workspace, and again for each worktree
 * switched to while inside it, if the counts on screen are older than
 * AUTO_FETCH_AFTER_MS (see shouldAutoFetch). Moving between the workspace's
 * segments and layers does not count as arriving: the caller stays mounted
 * across them. Called by the workspace and, at `expanded`, by the sidebar's
 * Git list while it is on screen; a fetch already running is never started
 * again, so the two never fetch twice.
 *
 * The decision waits for branch data that belongs to the worktree it is made
 * for. During a switch the cache still holds the previous worktree's answer,
 * and a fetch sent before the connection is rebound would run there too — so
 * nothing is decided between the switch starting and it settling, and then
 * only once the refetch the switch triggers has landed — and landed without
 * error, since a failed refetch leaves the previous answer in place.
 *
 * A switch that never settles (it failed, or the connection dropped under it)
 * leaves a workspace that was open for it unfetched: the safe way to be wrong,
 * as the chip still says how old its counts are. A workspace opened only after
 * such a switch is not protected — nothing told the branch cache either, so it
 * reads the previous worktree like every other git reader does then; the fetch
 * itself still goes to the right worktree, the reconnect having bound it.
 */
export function useAutoFetch() {
	const worktree = useWorktreeStore((s) => s.current);
	const { data: branches, isFetching, isError } = useGitBranches();
	const { startAutoFetch } = useGitSyncRunner();
	const switching = useIsWorktreeSwitching();
	// The worktree this visit has already decided for, so a refetch landing
	// later — git.changed, or the fetch's own invalidation — decides nothing.
	const decidedFor = useRef<string | null>(null);

	useEffect(() => {
		if (switching || isFetching || isError || !branches) return;
		if (decidedFor.current === worktree) return;
		decidedFor.current = worktree;

		const running = useGitSyncStore.getState().runs[worktree]?.running ?? null;
		if (shouldAutoFetch(branches, running, Date.now())) startAutoFetch();
	});
}
