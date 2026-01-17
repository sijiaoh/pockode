import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";

interface UseGitDiffOptions {
	path: string;
	staged: boolean;
	enabled?: boolean;
}

export const gitDiffQueryKey = (path: string, staged: boolean) =>
	["git-diff", path, staged] as const;

export function useGitDiff({
	path,
	staged,
	enabled = true,
}: UseGitDiffOptions) {
	const getDiff = useWSStore((state) => state.actions.getDiff);

	return useQuery({
		queryKey: gitDiffQueryKey(path, staged),
		queryFn: () => getDiff(path, staged),
		enabled: enabled && !!path,
		// TODO: GitWatcher uses --stat which doesn't detect all changes.
		// Keep staleTime: 0 to increase refetch opportunities until watcher detection is improved.
		staleTime: 0,
	});
}
