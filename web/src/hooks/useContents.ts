import { useQuery } from "@tanstack/react-query";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import { isRPCTimeout, useWSStore } from "../lib/wsStore";
import type {
	ContentsResponse,
	FileContent,
	LinkResult,
} from "../types/contents";

export const contentsQueryKey = (path: string) => ["contents", path] as const;

type GetFile = ReturnType<typeof useWSStore.getState>["actions"]["getFile"];

/**
 * What the `contentsQueryKey` entry holds, in the one shape every reader of it
 * stores: `useAttachmentContent` shares the entry for a path.
 */
export async function readContents(
	getFile: GetFile,
	path: string,
): Promise<ContentsResponse> {
	const result = await getFile(path);
	if (result.type === "directory") {
		return result.entries ?? [];
	}
	if (result.type === "link") {
		return result.link as LinkResult;
	}
	return result.file as FileContent;
}

export function isNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.startsWith("not found:");
}

export function useContents(path = "", enabled = true) {
	const getFile = useWSStore((state) => state.actions.getFile);

	return useQuery<ContentsResponse>({
		queryKey: contentsQueryKey(path),
		queryFn: () => readContents(getFile, path),
		enabled,
		staleTime: Number.POSITIVE_INFINITY,
		// A timeout here means the read was slow, not that it failed, and this is
		// a query whose reads can carry megabytes: retrying makes the server
		// re-read, re-encode and re-send the whole thing while the first attempt is
		// very likely still in flight, turning one slow response into four. Every
		// other kind of failure keeps the default retry budget. `useCommitFile`
		// reads blobs of the same size and follows the same rule. A path that is
		// not there will not be there a second later either: asking again only
		// keeps the reader waiting on a loading state for the answer they have.
		retry: (failureCount, error) =>
			!isRPCTimeout(error) &&
			!isNotFoundError(error) &&
			failureCount < DEFAULT_RETRY_COUNT,
	});
}
