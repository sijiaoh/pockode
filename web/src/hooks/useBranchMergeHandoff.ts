import { createContext, useContext, useMemo, useState } from "react";
import type { GitFailure } from "../utils/gitErrors";
import { usePrefillComposer } from "./usePrefillComposer";

export interface BranchMergeHandoff {
	/**
	 * The key of the branch row whose merge is waiting for a new session, null
	 * when none is.
	 */
	handingOff: string | null;
	error: GitFailure | null;
	dismissError: () => void;
	start: (rowKey: string, text: string) => void;
}

/**
 * A branch's `Ask AI to merge into current branch`
 * (docs/git-branches-ui.md#asking-the-agent-to-merge). Called once, by the
 * app shell, and handed to the Git surfaces through
 * `BranchMergeHandoffContext`: the Branches segment unmounts when the user
 * moves to another one, and a create still running then must keep switching
 * held when they come back, and its failure must still be shown. And at
 * `expanded` the list is in the sidebar while a branch's detail is in the
 * main area, so a press in either is lit in both, and failed in one place.
 *
 * The prefill hook's `isPending` is its own, so the pressed row is
 * remembered beside it.
 */
export function useBranchMergeHandoff(): BranchMergeHandoff {
	const { prefill, isPending, error, dismissError } = usePrefillComposer();
	const [rowKey, setRowKey] = useState<string | null>(null);

	// Memoized: it is a context value, read across the shell.
	return useMemo(
		() => ({
			handingOff: isPending ? rowKey : null,
			error,
			dismissError,
			start: (key: string, text: string) => {
				setRowKey(key);
				void prefill(text);
			},
		}),
		[isPending, rowKey, error, dismissError, prefill],
	);
}

export const BranchMergeHandoffContext =
	createContext<BranchMergeHandoff | null>(null);

/** The app's one `useBranchMergeHandoff`, from `BranchMergeHandoffContext`. */
export function useSharedMergeHandoff(): BranchMergeHandoff {
	const handoff = useContext(BranchMergeHandoffContext);
	if (!handoff) {
		throw new Error(
			"useSharedMergeHandoff needs a BranchMergeHandoffContext above it",
		);
	}
	return handoff;
}
