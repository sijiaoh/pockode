import { useQuery } from "@tanstack/react-query";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import { isRPCTimeout, useWSStore } from "../lib/wsStore";
import type { Entry, FileContent } from "../types/contents";

type ContentsResponse = Entry[] | FileContent;

export const contentsQueryKey = (path: string) => ["contents", path] as const;

export function isNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.startsWith("not found:");
}

export function useContents(path = "", enabled = true) {
	const getFile = useWSStore((state) => state.actions.getFile);

	return useQuery<ContentsResponse>({
		queryKey: contentsQueryKey(path),
		queryFn: async () => {
			const result = await getFile(path);
			if (result.type === "directory") {
				return result.entries ?? [];
			}
			return result.file as FileContent;
		},
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		// A timeout here means the read was slow, not that it failed, and this is
		// the one query whose reads can carry megabytes: retrying makes the server
		// re-read, re-encode and re-send the whole thing while the first attempt is
		// very likely still in flight, turning one slow response into four. Every
		// other kind of failure keeps the default retry budget.
		retry: (failureCount, error) =>
			!isRPCTimeout(error) && failureCount < DEFAULT_RETRY_COUNT,
	});
}
