import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";

export function useCommitDiff(hash: string | null, path: string | null) {
	const getCommitDiff = useWSStore((state) => state.actions.getCommitDiff);

	return useQuery({
		queryKey: ["commit-diff", hash, path],
		queryFn: () => {
			if (!hash || !path) throw new Error("Hash and path are required");
			return getCommitDiff(hash, path);
		},
		enabled: !!hash && !!path,
	});
}
