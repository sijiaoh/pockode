import { useQuery } from "@tanstack/react-query";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import { isRPCTimeout, useWSStore } from "../lib/wsStore";

/**
 * The file as it stood in a commit.
 *
 * No `useFSWatch` and no staleness: what a commit holds is immutable history,
 * so once fetched it can never go out of date.
 */
export function useCommitFile(hash: string | null, path: string | null) {
	const getCommitFile = useWSStore((state) => state.actions.getCommitFile);

	return useQuery({
		queryKey: ["commit-file", hash, path],
		queryFn: () => {
			if (!hash || !path) throw new Error("Hash and path are required");
			return getCommitFile(hash, path);
		},
		enabled: !!hash && !!path,
		staleTime: Number.POSITIVE_INFINITY,
		// Same reasoning as `useContents`: a blob is as large as a working-tree
		// file, and a retry makes the server re-read, re-encode and re-send all of
		// it while the first attempt is very likely still in flight.
		retry: (failureCount, error) =>
			!isRPCTimeout(error) && failureCount < DEFAULT_RETRY_COUNT,
	});
}
