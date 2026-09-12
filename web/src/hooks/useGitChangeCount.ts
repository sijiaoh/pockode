import { useMemo } from "react";
import { flattenGitStatus } from "../types/git";
import { useGitStatus } from "./useGitStatus";

/**
 * How many files have uncommitted changes, submodules included.
 *
 * Staged and unstaged are deduplicated by path: a partially staged file is two
 * rows in the git panel but one changed file to the person reading the badge.
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
