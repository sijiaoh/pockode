import {
	type QueryClient,
	queryOptions,
	skipToken,
	useQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { fetchImageBlob, ImageResponseError } from "../lib/imageFetch";
import { DEFAULT_RETRY_COUNT } from "../lib/queryClient";
import type { ImageOrigin } from "../types/contents";
import type { ImageSource } from "../utils/fileView";
import { commitFileQueryKey } from "./useCommitFile";
import { contentsQueryKey } from "./useContents";

/**
 * A work-directory file's bytes are cached under the key of its description,
 * so whatever keeps that description current reaches them too: a file
 * rewritten on disk, deleted, or left behind by a worktree switch is
 * invalidated or dropped by prefix along with its `contents` entry, with
 * nothing here having to know those rules. A commit's file and an attachment
 * never change, so their keys only have to tell one apart from another.
 */
function imageQueryKey(origin: ImageOrigin): readonly unknown[] {
	switch (origin.kind) {
		case "file":
			return [...contentsQueryKey(origin.path), "image"] as const;
		case "commit":
			return [
				...commitFileQueryKey(origin.hash, origin.path),
				"image",
			] as const;
		case "attachment":
			return [
				"attachment",
				origin.worktree,
				origin.sessionId,
				origin.id,
				"image",
			] as const;
	}
}

/**
 * An image's bytes, for a reader that wants the Blob itself — saving it —
 * rather than something to put in an `<img>`.
 */
export function imageBlobQuery(origin: ImageOrigin, mime: string) {
	return queryOptions({
		queryKey: imageQueryKey(origin),
		queryFn: ({ signal }) => fetchImageBlob(origin, mime, signal),
		// Fresh until whatever owns the description says otherwise (see above).
		staleTime: Number.POSITIVE_INFINITY,
		retry: (failureCount, error) =>
			!(error instanceof ImageResponseError && error.status < 500) &&
			failureCount < DEFAULT_RETRY_COUNT,
	});
}

/**
 * An image's bytes as a Blob, whichever way the image reached the page — for
 * saving it. A remote image's are the ones its `<img>` already read, so this is
 * a cache hit unless the reader saves before they arrive.
 */
export async function imageSourceBlob(
	queryClient: QueryClient,
	source: ImageSource,
): Promise<Blob> {
	if (source.kind === "remote") {
		return queryClient.fetchQuery(imageBlobQuery(source.origin, source.mime));
	}
	// An external image's bytes would take a cross-origin `fetch`, which fails
	// on every host that sends no CORS headers; the viewer offers no Save for one.
	if (source.kind === "external") {
		throw new Error("an external image cannot be saved from here");
	}
	// Inline sources are the percent-encoded data URLs `getImageSource` builds.
	// Untyped: `saveBlob` retypes every Blob it saves.
	const comma = source.src.indexOf(",");
	return new Blob([decodeURIComponent(source.src.slice(comma + 1))]);
}

/**
 * A URL an `<img>` can show, for an image that may still have to be read.
 *
 * `enabled` is how a caller holds the read until the image is on screen. The
 * object URL lives exactly as long as the component showing it; the bytes
 * behind it stay in the query cache, so scrolling back to an image does not
 * read it again.
 */
export function useImageSrc(source: ImageSource | null, enabled = true) {
	const remote = source?.kind === "remote" ? source : null;
	const options = remote ? imageBlobQuery(remote.origin, remote.mime) : null;
	const query = useQuery({
		...(options ?? { queryKey: NO_IMAGE }),
		queryFn: options && enabled ? options.queryFn : skipToken,
	});
	const objectUrl = useObjectUrl(remote ? query.data : undefined);

	return {
		src:
			source?.kind === "inline"
				? source.src
				: source?.kind === "external"
					? source.url
					: objectUrl,
		// Withheld while a retry is running, so the caller shows it loading
		// rather than the failure it is already trying to get past.
		error: remote && !query.isFetching ? query.error : null,
		retry: () => void query.refetch(),
	};
}

const NO_IMAGE = ["image", "none"] as const;

/**
 * An object URL for `blob`, revoked when the blob changes or the caller
 * unmounts. Null until it exists, and never one made for a previous blob: that
 * URL is revoked in the same commit, and an `<img>` handed it would report a
 * decode failure for bytes nothing is wrong with.
 */
function useObjectUrl(blob: Blob | undefined): string | null {
	const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(
		null,
	);
	useEffect(() => {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		setCurrent({ blob, url });
		return () => URL.revokeObjectURL(url);
	}, [blob]);
	return current !== null && current.blob === blob ? current.url : null;
}
