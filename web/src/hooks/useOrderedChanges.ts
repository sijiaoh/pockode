import { useMemo } from "react";
import { collectChanges, orderChanges } from "../lib/gitChanges";
import { useGitChangesViewStore } from "../lib/gitChangesViewStore";
import type { GitStatus } from "../types/git";

/**
 * The changed files of `status` in the order the review walks them — the
 * Changes list's view, flat or tree — and that view. Every list of changed
 * files reads it here, so a row's place is its `k / n` in the review.
 */
export function useOrderedChanges(status: GitStatus | undefined) {
	const view = useGitChangesViewStore((s) => s.view);
	const files = useMemo(
		() => (status ? orderChanges(collectChanges(status), view) : []),
		[status, view],
	);
	return { files, view };
}
