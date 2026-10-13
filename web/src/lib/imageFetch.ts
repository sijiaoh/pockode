import type { ContentOrigin } from "../types/contents";
import { getMimeType, isImageMime } from "../utils/fileView";
import { createLimiter } from "../utils/limiter";
import { apiUrl, authHeaders } from "./api";
import { commitFileUrl, downloadUrl, readError } from "./fileDownload";
import { worktreeActions } from "./worktreeStore";

/**
 * Image reads allowed in flight at once.
 *
 * Through the relay every request is a stream on one tunnel that carries at
 * most 64 at a time, the WebSocket and every other API call included. A
 * transcript can put dozens of thumbnails on screen in one scroll, and letting
 * them all start would leave nothing for the rest of the app until the last one
 * finished. A few at a time also brings the pictures in one by one rather than
 * all of them slowly together, since they share the same bandwidth either way.
 */
export const IMAGE_FETCH_CONCURRENCY = 4;

const limiter = createLimiter(IMAGE_FETCH_CONCURRENCY);

/**
 * The server answered with an error status. Carries the status because a 4xx
 * — an attachment cleaned up, a path a commit does not have — will be refused
 * the same way every time, while a 5xx or a read that never got through may
 * well succeed on another try.
 */
export class ImageResponseError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ImageResponseError";
		this.status = status;
	}
}

/**
 * The endpoint serving an origin's bytes.
 *
 * A file's worktree is read when the request is made: the WebSocket answered
 * for the worktree it is bound to, which `worktreeActions` tracks, and a switch
 * invalidates every `contents` entry the bytes are cached under. A commit's
 * file is the same from any worktree of the repository. An attachment carries
 * its own (`ContentOrigin`), since its session lives in only one.
 */
export function imageUrl(origin: ContentOrigin): string {
	switch (origin.kind) {
		case "file":
			return downloadUrl(origin.path, worktreeActions.getCurrent());
		case "commit":
			return commitFileUrl(
				origin.hash,
				origin.path,
				worktreeActions.getCurrent(),
			);
		case "attachment":
			return endpoint(
				"/api/chat/attachments",
				{ session_id: origin.sessionId, id: origin.id },
				origin.worktree,
			);
	}
}

function endpoint(
	path: string,
	params: Record<string, string>,
	worktree: string,
): string {
	const query = new URLSearchParams(params);
	if (worktree) query.set("worktree", worktree);
	return apiUrl(`${path}?${query.toString()}`);
}

/**
 * The type to put on the Blob: the description's, if it is a raster image.
 * An object URL is same-origin with the app, so bytes typed as SVG — which can
 * hold script — would run as the app if opened on their own. The server never
 * sends SVG as `http`; this keeps a description that did from producing one.
 */
function blobType(mime: string): string {
	const type = getMimeType(mime);
	return isImageMime(type) && type !== "image/svg+xml"
		? type
		: "application/octet-stream";
}

/**
 * Reads an image's bytes, typed from `mime` (see `blobType`).
 *
 * Typed here because the server sends every file as
 * `application/octet-stream`, and what the description says — sniffed from the
 * bytes — is the type the browser should decode them as.
 */
export async function fetchImageBlob(
	origin: ContentOrigin,
	mime: string,
	signal?: AbortSignal,
): Promise<Blob> {
	return limiter.run(async () => {
		const response = await fetch(imageUrl(origin), {
			headers: authHeaders(),
			signal,
		});
		if (!response.ok) {
			const error = await readError(response);
			throw new ImageResponseError(response.status, error.message);
		}
		const bytes = await response.blob();
		return bytes.slice(0, bytes.size, blobType(mime));
	}, signal);
}
