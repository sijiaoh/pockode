import { useQuery } from "@tanstack/react-query";
import { getGitDiff } from "../lib/gitApi";

interface UseGitDiffOptions {
	path: string;
	staged: boolean;
	enabled?: boolean;
}

export function useGitDiff({
	path,
	staged,
	enabled = true,
}: UseGitDiffOptions) {
	return useQuery({
		queryKey: ["git-diff", path, staged],
		queryFn: () => getGitDiff(path, staged),
		enabled: enabled && !!path,
		staleTime: 0,
	});
}
