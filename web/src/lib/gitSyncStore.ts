import { create } from "zustand";

export type SyncOperation = "fetch" | "pull" | "push";

export type SyncOutcome =
	| { kind: "error"; summary: string; detail: string }
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
	 * @param summarize turns git's own message into one line of plain language.
	 */
	start: async (
		worktree: string,
		operation: SyncOperation,
		action: () => Promise<string>,
		summarize: (detail: string) => string,
	) => {
		// The only guard against a second run: neither react-query nor the server
		// deduplicates, and two concurrent pulls end with the loser reporting an
		// index.lock error that means nothing to the user.
		if (useGitSyncStore.getState().runs[worktree]?.running) return;

		setRun(worktree, { running: operation, outcome: null });
		try {
			const message = await action();
			setRun(worktree, {
				running: null,
				outcome: { kind: "success", message },
			});
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			setRun(worktree, {
				running: null,
				outcome: { kind: "error", summary: summarize(detail), detail },
			});
		}
	},

	dismissOutcome: (worktree: string) => setRun(worktree, { outcome: null }),

	reset: () => useGitSyncStore.setState({ runs: {} }),
};

export function useSyncRun(worktree: string): SyncRun {
	return useGitSyncStore((s) => s.runs[worktree] ?? IDLE);
}
