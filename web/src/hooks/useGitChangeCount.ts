import { useMemo } from "react";
import { formatBadgeCount } from "../components/ui/BadgeCount";
import { collectChanges, sumLines } from "../lib/gitChanges";
import { flattenGitStatus, type LineStat } from "../types/git";
import { useGitStatus } from "./useGitStatus";

/**
 * How many files have uncommitted changes, submodules included.
 *
 * Staged and unstaged are deduplicated by path: a partially staged file is in
 * both of `git.status`'s lists but is one row, and one changed file.
 *
 * `undefined` until a status has arrived at all — the first read pending, or
 * failed. Both read as "no badge". A later failed refresh keeps the previous
 * answer instead, so the count goes stale rather than vanishing.
 */
export function useGitChangeCount(): number | undefined {
	const { data: status } = useGitStatus();

	return useMemo(() => {
		if (!status) return undefined;
		const { staged, unstaged } = flattenGitStatus(status);
		return new Set([...staged, ...unstaged].map((f) => f.path)).size;
	}, [status]);
}

/**
 * The count as it is spoken — by the Git tab's badge and by the Changes entry
 * inside the tab, which show the same number and so must say it the same way.
 */
export function describeChangeCount(count: number): string {
	return `${formatBadgeCount(count)} changed ${count === 1 ? "file" : "files"}`;
}

/**
 * Lines added and removed across every changed file, as the Changes list's
 * header sums them; null when there is no status or nothing could be counted
 * (every file binary or too large), which is left unsaid rather than `+0 −0`.
 */
export function useGitChangeLines(): LineStat | null {
	const { data: status } = useGitStatus();

	return useMemo(
		() => (status ? sumLines(collectChanges(status)) : null),
		[status],
	);
}

/** The totals as they are spoken: `142 lines added, 37 removed`. */
export function describeChangeLines({
	additions,
	deletions,
}: LineStat): string {
	return `${additions} ${additions === 1 ? "line" : "lines"} added, ${deletions} removed`;
}
