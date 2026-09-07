import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";
import type { GitStatus } from "../types/git";
import { gitStatusQueryKey } from "./gitQueries";

export function useGitStatus() {
	const getStatus = useWSStore((state) => state.actions.getStatus);

	return useQuery({
		queryKey: gitStatusQueryKey,
		queryFn: getStatus,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * Resolve the git index path for a file path.
 * For root files, returns ".git/index".
 * For submodule files, returns ".git/modules/<submodule>/index".
 *
 * Note: Pockode does not support nested submodules.
 */
export function resolveGitIndexPath(
	gitStatus: GitStatus | undefined,
	filePath: string,
): string {
	if (!gitStatus?.submodules) {
		return ".git/index";
	}

	for (const subPath of Object.keys(gitStatus.submodules)) {
		const prefix = `${subPath}/`;
		if (filePath.startsWith(prefix)) {
			return `.git/modules/${subPath}/index`;
		}
	}

	return ".git/index";
}
