import { useState } from "react";
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
 * (docs/git-branches-ui.md#asking-the-agent-to-merge). Called by the Git
 * workspace, not the Branches segment: the segment unmounts when the user
 * moves to another one, and a create still running then must keep the list
 * held when they come back, and its failure must still be shown.
 *
 * The prefill hook's `isPending` is its own, so the pressed row is
 * remembered beside it.
 */
export function useBranchMergeHandoff(): BranchMergeHandoff {
	const { prefill, isPending, error, dismissError } = usePrefillComposer();
	const [rowKey, setRowKey] = useState<string | null>(null);

	return {
		handingOff: isPending ? rowKey : null,
		error,
		dismissError,
		start: (key, text) => {
			setRowKey(key);
			void prefill(text);
		},
	};
}
