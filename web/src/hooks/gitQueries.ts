import type { QueryClient } from "@tanstack/react-query";
import { describeOperationPrompt, headBranchOf } from "../lib/gitOperation";
import { allConflicted, type GitBranches, type GitStatus } from "../types/git";

export const gitStatusQueryKey = ["git-status"] as const;
export const gitLogQueryKey = ["git-log"] as const;
export const gitBranchesQueryKey = ["git-branches"] as const;
/** Prefix of `useGitCommit`'s keys: a commit never changes, its refs do. */
export const gitCommitQueryKey = ["git-commit"] as const;

/**
 * Refetch everything the Git workspace reads.
 *
 * Mutations call this on success instead of waiting out GitWatcher's 3-second
 * poll, and moving HEAD invalidates them all at once — a checkout changes the
 * status, the history, the branch list and the refs on an open commit
 * together.
 */
export function invalidateGitQueries(queryClient: QueryClient): void {
	for (const queryKey of [
		gitStatusQueryKey,
		gitLogQueryKey,
		gitBranchesQueryKey,
		gitCommitQueryKey,
	]) {
		queryClient.invalidateQueries({ queryKey });
	}
}

/**
 * What a handoff of the repository's unfinished state gives the agent — the
 * banner's `Resolve with agent`, the conflict view's `Ask agent` — built from
 * the cache at the press, never from what the pressed surface last rendered.
 * Null when there is nothing left to hand over.
 */
export function operationPromptAtPress(
	queryClient: QueryClient,
): string | null {
	const status = queryClient.getQueryData<GitStatus>(gitStatusQueryKey);
	const conflicted = status ? allConflicted(status) : [];
	if (!status || (!status.operation && conflicted.length === 0)) return null;
	const head = queryClient.getQueryData<GitBranches>(gitBranchesQueryKey)?.head;
	return describeOperationPrompt(
		status.operation,
		conflicted,
		headBranchOf(head),
	);
}

/**
 * Drop everything the Git workspace read, for a project that has just stopped
 * being a repository.
 *
 * Not invalidateGitQueries: the listener that learns the news runs before React
 * re-renders, while the readers still hold `enabled: true`, so an invalidation
 * would send every one of them off to be refused with -32002 — and retried.
 * Removing also cancels whatever is in flight, and leaves no error behind to
 * flash up if a later `git init` brings the workspace back.
 */
export function removeGitQueries(queryClient: QueryClient): void {
	for (const queryKey of [
		gitStatusQueryKey,
		gitLogQueryKey,
		gitBranchesQueryKey,
		gitCommitQueryKey,
	]) {
		queryClient.removeQueries({ queryKey });
	}
}
