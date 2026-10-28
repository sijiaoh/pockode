import { create } from "zustand";
import {
	branchRefusalSummary,
	describeGitFailure,
	type GitFailure,
	gitRefusalSummary,
} from "../utils/gitErrors";
import { worktreeActions } from "./worktreeStore";

export interface CheckoutRun {
	/** The branch a switch is running to, and null while none is. */
	switchingTo: string | null;
	/** How the last switch failed, until it is dismissed or the next one starts. */
	error: GitFailure | null;
	/** The local branch a delete is running for, and null while none is. */
	deleting: string | null;
	/** How the last delete failed, until it is dismissed or the next one starts. */
	deleteError: GitFailure | null;
}

interface GitCheckoutState {
	/** Keyed by worktree name, the same key the rest of the workspace switches on. */
	runs: Record<string, CheckoutRun>;
}

/**
 * Which branch switch is in flight in each worktree, and how the last one
 * failed — and the same for deleting a branch, whose confirm closes when the
 * user navigates away while the request keeps running.
 *
 * It lives outside the Branches segment because a switch can be walked away
 * from: the segment control, the top bar and Back all leave the segment while
 * the request runs, which a sheet that could not be closed mid-switch never
 * allowed. A failure that settled with nobody on the segment would otherwise
 * be lost, and a user who believes the switch happened goes on to have an
 * agent work on the wrong branch. Coming back mid-switch has to show the
 * spinner, too, and keep the second switch from being started on top of it.
 *
 * Not part of gitWriteStore, although that one also holds write failures: it
 * queues the quick local writes — stage, unstage, discard — one behind another,
 * and a switch is no such write. It replaces the whole working tree, so it must
 * not wait behind (or hold up) a queue of row actions, and a second one is
 * refused rather than queued. That is gitSyncStore's semantics — one run per
 * worktree, its outcome kept after the page is left — so this mirrors it.
 *
 * Keyed by worktree for the reason gitSyncStore is: a switch is a request to
 * the worktree it was started in, and its outcome is about that one.
 */
export const useGitCheckoutStore = create<GitCheckoutState>(() => ({
	runs: {},
}));

/** A worktree nothing has been switched in, as a stable identity for selectors. */
const IDLE: CheckoutRun = {
	switchingTo: null,
	error: null,
	deleting: null,
	deleteError: null,
};

function setRun(worktree: string, patch: Partial<CheckoutRun>) {
	useGitCheckoutStore.setState((s) => ({
		runs: {
			...s.runs,
			[worktree]: { ...(s.runs[worktree] ?? IDLE), ...patch },
		},
	}));
}

/**
 * git's own refusal ends with "commit your changes or stash them". Pockode never
 * stashes — worktrees share one stash stack (docs/git-ui.md) — so the summary
 * names the two options the workspace actually offers. Unmatched messages (other
 * failures, a non-English git) simply get no extra guidance.
 */
const OVERWRITE_REFUSAL = /would be overwritten by checkout/i;

function describeCheckoutFailure(err: unknown, branch: string): GitFailure {
	const refusal = gitRefusalSummary(err);
	// A refusal explains itself, but not which row it was about, and the list is
	// taller than the screen: the branch that was tapped has usually scrolled
	// away by the time this is read — or the user has left the list entirely.
	if (refusal) {
		return {
			summary: `Could not switch to ${branch}. ${refusal}`,
			detail: null,
		};
	}
	return describeGitFailure(err, (detail) =>
		OVERWRITE_REFUSAL.test(detail)
			? `Could not switch to ${branch}. Commit or discard these changes first.`
			: `Could not switch to ${branch}.`,
	);
}

function describeDeleteFailure(err: unknown, branch: string): GitFailure {
	// Recognised by code, never by the server's sentence.
	const branchRefusal = branchRefusalSummary(err, branch);
	if (branchRefusal) return { summary: branchRefusal, detail: null };
	const refusal = gitRefusalSummary(err);
	if (refusal) {
		return { summary: `Could not delete ${branch}. ${refusal}`, detail: null };
	}
	return describeGitFailure(err, () => `Could not delete ${branch}.`);
}

export const gitCheckoutActions = {
	/**
	 * Starting a switch puts away the last one's failure, and success leaves
	 * nothing behind: the check moving and the top bar's branch name changing
	 * are the whole report of it.
	 */
	start: async (
		worktree: string,
		branch: string,
		action: () => Promise<unknown>,
	) => {
		if (useGitCheckoutStore.getState().runs[worktree]?.switchingTo) return;

		setRun(worktree, { switchingTo: branch, error: null });
		try {
			await action();
			setRun(worktree, { switchingTo: null });
		} catch (err) {
			setRun(worktree, {
				switchingTo: null,
				error: describeCheckoutFailure(err, branch),
			});
		}
	},

	dismissError: (worktree: string) => setRun(worktree, { error: null }),

	/**
	 * Never rejects: the confirm awaiting it closes either way, and a failure
	 * is kept here to be shown in the list's pinned area or the top bar. Success
	 * leaves nothing behind — the row going is the report of it.
	 *
	 * Resolves to whether the branch was deleted, for the branch's detail,
	 * which leaves for the list only then: the row going is no evidence, since
	 * the delete refreshes the list before it answers and a branch can go for
	 * other reasons (docs/git-branches-ui.md#when-the-branch-goes-away).
	 */
	startDelete: async (
		worktree: string,
		branch: string,
		action: () => Promise<unknown>,
	): Promise<boolean> => {
		// Refused, not queued — but said: the confirm awaiting this closes, and
		// a delete that silently never ran would read as one that did.
		const running = useGitCheckoutStore.getState().runs[worktree]?.deleting;
		if (running) {
			setRun(worktree, {
				deleteError: {
					summary: `Could not delete ${branch}. Deleting ${running} is still in progress.`,
					detail: null,
				},
			});
			return false;
		}

		setRun(worktree, { deleting: branch, deleteError: null });
		try {
			await action();
			setRun(worktree, { deleting: null });
			return true;
		} catch (err) {
			setRun(worktree, {
				deleting: null,
				deleteError: describeDeleteFailure(err, branch),
			});
			return false;
		}
	},

	dismissDeleteError: (worktree: string) =>
		setRun(worktree, { deleteError: null }),

	reset: () => useGitCheckoutStore.setState({ runs: {} }),
};

// The same rule as gitSyncStore's: a failure is about the repository it ran
// against, which is not the one a later banner would sit under once the answer
// flips. What is still running is left alone; its settling lifts the guard.
worktreeActions.onGitRepoChange(() => {
	useGitCheckoutStore.setState((s) => ({
		runs: Object.fromEntries(
			Object.entries(s.runs).map(([worktree, run]) => [
				worktree,
				{ ...run, error: null, deleteError: null },
			]),
		),
	}));
});

export function useCheckoutRun(worktree: string): CheckoutRun {
	return useGitCheckoutStore((s) => s.runs[worktree] ?? IDLE);
}
