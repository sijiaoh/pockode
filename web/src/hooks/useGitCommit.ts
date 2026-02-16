import { useQuery } from "@tanstack/react-query";
import { useWSStore } from "../lib/wsStore";

export function useGitCommit(hash: string | null) {
	const getCommit = useWSStore((state) => state.actions.getCommit);

	return useQuery({
		queryKey: ["git-commit", hash],
		queryFn: () => {
			if (!hash) throw new Error("Hash is required");
			return getCommit(hash);
		},
		enabled: !!hash,
	});
}
