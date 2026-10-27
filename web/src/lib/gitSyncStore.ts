import { create } from "zustand";
import { describeGitFailure, type GitFailure } from "../utils/gitErrors";
import { worktreeActions } from "./worktreeStore";

export type SyncOperation = "fetch" | "pull" | "push";

export type SyncOutcome =
	| ({ kind: "error" } & GitFailure)
	| { kind: "success"; message: string };

export interface SyncRun {
	running: SyncOperation | null;
	outcome: SyncOutcome | null;
	/**
	 * Whether the run that is going, or that left `outcome`, was the automatic
	 * fetch rather than one the user asked for. Nobody asked for an automatic
	 * one, so its failure is marked on the sync chip (and in the sidebar's Git
	 * overview, which reads the same status) rather than in a banner,
	 * and its success leaves nothing to report at all.
	 */
	auto: boolean;
}

interface GitSyncState {
	/** Keyed by worktree name, the same key the rest of the workspace switches on. */
	runs: Record<string, SyncRun>;
}

/**
 * Which sync is in flight in each worktree, and how the last one ended.
 *
 * It lives outside the sync sheet because the sheet can be closed while fetch,
 * pull or push is still running: the run has to outlive the component that
 * started it, and so does the guard that stops a second one being launched on
 * top of it. Nothing else in the workspace can hold it either — BranchBar
 * unmounts whenever the user leaves the Git workspace, which would take a
 * running operation's identity down with it.
 *
 * Keyed by worktree rather than held as one record because switching worktrees
 * mid-run is now reachable: a single record would show A's outcome under B, or
 * let A's in-flight operation disable B's buttons.
 */
export const useGitSyncStore = create<GitSyncState>(() => ({ runs: {} }));

/** A worktree nothing has ever run in, as a stable identity for selectors. */
const IDLE: SyncRun = { running: null, outcome: null, auto: false };

function setRun(worktree: string, patch: Partial<SyncRun>) {
	useGitSyncStore.setState((s) => ({
		runs: {
			...s.runs,
			[worktree]: { ...(s.runs[worktree] ?? IDLE), ...patch },
		},
	}));
}

/** Leads the reason, so the sheet says which fetch it was before why it failed. */
export const AUTO_FETCH_FAILURE = "Automatic fetch failed.";

export const gitSyncActions = {
	/**
	 * @param action resolves to the sentence shown on success.
	 * @param summarize turns git's own message into one line of plain language;
	 * a request the server refused never reaches it, since there is no git
	 * output to read (see describeGitFailure).
	 */
	start: async (
		worktree: string,
		operation: SyncOperation,
		action: () => Promise<string>,
		summarize: (detail: string) => string,
	) => {
		// Still the only thing that stops a second run of the same operation: the
		// server refuses one that collides, but "this worktree is busy pulling"
		// is a poor answer to a second tap on Pull, and a refusal arrives only
		// after the two seconds it waits first.
		if (useGitSyncStore.getState().runs[worktree]?.running) return;

		setRun(worktree, { running: operation, outcome: null, auto: false });
		try {
			const message = await action();
			setRun(worktree, {
				running: null,
				outcome: { kind: "success", message },
			});
		} catch (err) {
			setRun(worktree, {
				running: null,
				outcome: { kind: "error", ...describeGitFailure(err, summarize) },
			});
		}
	},

	/**
	 * The fetch the workspace runs by itself on the way in. The same run as a
	 * manual fetch — the same guard, the same spinner, the same buttons disabled
	 * in the sheet — except for what it leaves behind: nothing on success, since
	 * "Fetched." answers a question the user never asked, and on failure an
	 * outcome marked `auto`, so the chip carries it instead of a banner.
	 */
	startAutoFetch: async (worktree: string, action: () => Promise<void>) => {
		if (useGitSyncStore.getState().runs[worktree]?.running) return;

		setRun(worktree, { running: "fetch", outcome: null, auto: true });
		try {
			await action();
			setRun(worktree, { running: null });
		} catch (err) {
			const failure = describeGitFailure(err, () => AUTO_FETCH_FAILURE);
			setRun(worktree, {
				running: null,
				outcome: {
					kind: "error",
					// A refusal brings its own sentence and no git output; it still
					// has to say which fetch was refused.
					summary:
						failure.detail === null
							? `${AUTO_FETCH_FAILURE} ${failure.summary}`
							: failure.summary,
					detail: failure.detail,
				},
			});
		}
	},

	dismissOutcome: (worktree: string) => setRun(worktree, { outcome: null }),

	reset: () => useGitSyncStore.setState({ runs: {} }),
};

// An outcome answers a question about the repository it ran against. Whichever
// way the answer flipped, that repository is not the one a later banner would
// sit under. A run refused because .git was gone can settle after the flip; the
// Git workspace has been left by then, and the flip back after `git init`
// clears it. What is still running is left alone: its settling is what lifts the guard.
worktreeActions.onGitRepoChange(() => {
	useGitSyncStore.setState((s) => ({
		runs: Object.fromEntries(
			Object.entries(s.runs).map(([worktree, run]) => [
				worktree,
				{ ...run, outcome: null },
			]),
		),
	}));
});

export function useSyncRun(worktree: string): SyncRun {
	return useGitSyncStore((s) => s.runs[worktree] ?? IDLE);
}
