import { create } from "zustand";
import type {
	GitAbortResult,
	GitOperation,
	GitOperationKind,
} from "../types/git";
import type { GitFailure } from "../utils/gitErrors";
import {
	changedOperation,
	describeAbortFailure,
	operationKey,
} from "./gitOperation";
import { worktreeActions } from "./worktreeStore";

/**
 * Which operation something is about: one by its `operationKey`, or — when
 * only the kind is known, as a -32008 names the new one — any of that kind.
 */
export interface OperationRef {
	kind: GitOperationKind;
	key: string | null;
}

/** Whether `ref` is about `operation`, the one in progress (null for none). */
export function isAbout(
	ref: OperationRef,
	operation: GitOperation | null,
): boolean {
	if (!operation) return false;
	return ref.key !== null
		? ref.key === operationKey(operation)
		: ref.kind === operation.kind;
}

export interface AbortRun {
	/**
	 * The operation an abort was sent for. Kept after the request succeeds,
	 * until the status stops showing that operation: the spinner stays until
	 * the banner leaves (docs/git-conflict-ui.md, no optimism). By key, so a
	 * new operation of the same kind does not inherit the spinner.
	 */
	aborting: (OperationRef & { settled: boolean }) | null;
	/**
	 * How the last abort failed, and the operation in progress it is about —
	 * which, when the operation changed meanwhile, is the new one, known only
	 * by its kind. Shown only while that operation is still in progress.
	 */
	error: (OperationRef & { failure: GitFailure }) | null;
	/** An abort git ended without moving the branch back. */
	headKept: { kind: GitOperationKind; branch: string | null } | null;
	/**
	 * When the last abort was answered (`Date.now()`), 0 before any. A status
	 * read before then cannot clear what the answer left: it predates it — a
	 * -32008 names an operation that status has not shown yet.
	 */
	answeredAt: number;
}

interface GitOperationState {
	/** Keyed by worktree name, as the other git stores are. */
	runs: Record<string, AbortRun>;
	/** Per worktree, the `operationKey` of the operation whose banner is collapsed. */
	collapsed: Record<string, string>;
}

/**
 * The abort of an in-progress merge, rebase, cherry-pick or revert, and what it
 * left behind; and which operation's banner the user collapsed.
 *
 * A store for gitCheckoutStore's reason: the banner the abort is pressed in
 * lives on every workspace layer, but the workspace itself can be left while
 * the request runs, and a failure that settled with nobody looking must still
 * be there on return. The collapse is here only because it is per worktree and
 * per operation, which a component's state cannot be.
 */
export const useGitOperationStore = create<GitOperationState>(() => ({
	runs: {},
	collapsed: {},
}));

const IDLE: AbortRun = {
	aborting: null,
	error: null,
	headKept: null,
	answeredAt: 0,
};

function setRun(worktree: string, patch: Partial<AbortRun>) {
	useGitOperationStore.setState((s) => ({
		runs: {
			...s.runs,
			[worktree]: { ...(s.runs[worktree] ?? IDLE), ...patch },
		},
	}));
}

export const gitOperationActions = {
	abort: async (
		worktree: string,
		operation: GitOperation,
		branch: string | null,
		action: () => Promise<GitAbortResult>,
	) => {
		const { kind } = operation;
		const key = operationKey(operation);
		if (
			useGitOperationStore.getState().runs[worktree]?.aborting?.settled ===
			false
		)
			return;

		setRun(worktree, {
			aborting: { kind, key, settled: false },
			error: null,
			headKept: null,
		});
		try {
			const result = await action();
			setRun(worktree, {
				aborting: { kind, key, settled: true },
				headKept: result.head_kept ? { kind, branch } : null,
				answeredAt: Date.now(),
			});
		} catch (err) {
			const failure = describeAbortFailure(err, kind);
			const changedTo = changedOperation(err)?.current;
			setRun(worktree, {
				aborting: null,
				error: failure
					? changedTo
						? { failure, kind: changedTo, key: null }
						: { failure, kind, key }
					: null,
				answeredAt: Date.now(),
			});
		}
	},

	/**
	 * Drops what no longer applies to the operation in progress now, `null`
	 * for none, as a status answered at `statusAt` (react-query's
	 * `dataUpdatedAt`) shows it. Called with every status the banner draws
	 * from; an abort's answer is followed by the refetch it asks for.
	 */
	settle: (
		worktree: string,
		current: GitOperation | null,
		statusAt: number,
	) => {
		const run = useGitOperationStore.getState().runs[worktree];
		if (!run || statusAt < run.answeredAt) return;
		const patch: Partial<AbortRun> = {};
		if (run.aborting?.settled && !isAbout(run.aborting, current)) {
			patch.aborting = null;
		}
		if (run.error && !isAbout(run.error, current)) patch.error = null;
		// About the operation that ended; once another is in progress it would
		// come back, false, when that one ends.
		if (run.headKept && current !== null) patch.headKept = null;
		if (Object.keys(patch).length > 0) setRun(worktree, patch);
	},

	dismissError: (worktree: string) => setRun(worktree, { error: null }),

	dismissHeadKept: (worktree: string) => setRun(worktree, { headKept: null }),

	setCollapsed: (worktree: string, key: string, collapsed: boolean) => {
		useGitOperationStore.setState((s) => {
			const { [worktree]: _, ...rest } = s.collapsed;
			return { collapsed: collapsed ? { ...rest, [worktree]: key } : rest };
		});
	},

	reset: () => useGitOperationStore.setState({ runs: {}, collapsed: {} }),
};

// The same rule as the other git stores': what was said is about the
// repository it ran against. What is still running is left alone.
worktreeActions.onGitRepoChange(() => {
	useGitOperationStore.setState((s) => ({
		runs: Object.fromEntries(
			Object.entries(s.runs).map(([worktree, run]) => [
				worktree,
				{ ...run, error: null, headKept: null },
			]),
		),
	}));
});

export function useAbortRun(worktree: string): AbortRun {
	return useGitOperationStore((s) => s.runs[worktree] ?? IDLE);
}

export function useIsOperationCollapsed(
	worktree: string,
	key: string,
): boolean {
	return useGitOperationStore((s) => s.collapsed[worktree] === key);
}
