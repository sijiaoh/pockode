import { create } from "zustand";
import { describeGitFailure, type GitFailure } from "../utils/gitErrors";

export type SyncOperation = "fetch" | "pull" | "push";

export type SyncOutcome =
	| ({ kind: "error" } & GitFailure)
	| { kind: "success"; message: string };

export interface SyncRun {
	running: SyncOperation | null;
	outcome: SyncOutcome | null;
}

interface GitSyncState {
	/** Keyed by worktree name, the same key the rest of the panel switches on. */
	runs: Record<string, SyncRun>;
}

/**
 * Which sync is in flight in each worktree, and how the last one ended.
 *
 * It lives outside the sync sheet because the sheet can be closed while fetch,
 * pull or push is still running: the run has to outlive the component that
 * started it, and so does the guard that stops a second one being launched on
 * top of it. Nothing else in the panel can hold it either — BranchBar remounts
 * across the desktop breakpoint (Layout/Sidebar.tsx), which would take a
 * running operation's identity down with it.
 *
 * Keyed by worktree rather than held as one record because switching worktrees
 * mid-run is now reachable: a single record would show A's outcome under B, or
 * let A's in-flight operation disable B's buttons.
 */
export const useGitSyncStore = create<GitSyncState>(() => ({ runs: {} }));

/** A worktree nothing has ever run in, as a stable identity for selectors. */
const IDLE: SyncRun = { running: null, outcome: null };

function setRun(worktree: string, patch: Partial<SyncRun>) {
	useGitSyncStore.setState((s) => ({
		runs: {
			...s.runs,
			[worktree]: { ...(s.runs[worktree] ?? IDLE), ...patch },
		},
	}));
}

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

		setRun(worktree, { running: operation, outcome: null });
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

	dismissOutcome: (worktree: string) => setRun(worktree, { outcome: null }),

	reset: () => useGitSyncStore.setState({ runs: {} }),
};

export function useSyncRun(worktree: string): SyncRun {
	return useGitSyncStore((s) => s.runs[worktree] ?? IDLE);
}
