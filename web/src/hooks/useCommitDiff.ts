import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";

interface UseCommitDiffOptions {
	hash: string | null;
	path: string | null;
	hideWhitespace?: boolean;
}

export function useCommitDiff({
	hash,
	path,
	hideWhitespace = false,
}: UseCommitDiffOptions) {
	const getCommitDiff = useWSStore((state) => state.actions.getCommitDiff);

	return useQuery({
		queryKey: ["commit-diff", hash, path, hideWhitespace],
		queryFn: () => {
			if (!hash || !path) throw new Error("Hash and path are required");
			return getCommitDiff(hash, path, hideWhitespace);
		},
		enabled: !!hash && !!path,
	});
}
