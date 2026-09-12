import { splitPath } from "../utils/path";
import { apiUrl, authHeaders, logoutIfUnauthorized } from "./api";

/**
 * Bytes requested per `Range` request.
 *
 * Downloads are chunked unconditionally so that no response is unbounded — the
 * same reason a stale chunk is refused with 412 rather than `If-Range`, below.
 * It does not bound what the download holds: the chunks already collected are
 * kept until the file is whole, which is LARGE_DOWNLOAD_WARNING_SIZE's problem,
 * not this one's. One extra round trip per 4 MiB is what it costs.
 */
export const DOWNLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Size past which downloading is confirmed first.
 *
 * Nothing reaches the disk until the whole file has been assembled, and the
 * browser is holding every chunk until then; on a phone a few hundred megabytes
 * is enough for the tab to be killed partway through.
 */
export const LARGE_DOWNLOAD_WARNING_SIZE = 200 * 1024 * 1024;

const CHANGED_MID_DOWNLOAD =
	"The file changed while it was being downloaded. Try again.";

/**
 * What the endpoint sends, carried onto the assembled Blob.
 *
 * A Blob with no type is handled inconsistently by iOS Safari, which may show
 * it inline instead of saving it — and a phone is where this app is most used.
 */
const DOWNLOAD_MIME = "application/octet-stream";

/**
 * Server error codes phrased for the user; unlisted ones keep the server's own
 * message. A Map rather than an object literal because the key is whatever the
 * response says, and an object would answer for `toString` as readily as for a
 * code that exists.
 */
const ERROR_MESSAGES = new Map([
	["invalid_path", "Invalid file path"],
	["not_a_file", "This path is not a regular file"],
	["not_found", "File not found — it may have been moved or deleted"],
	["worktree_not_found", "Worktree not found"],
]);

function downloadUrl(path: string, worktree: string): string {
	const params = new URLSearchParams({ path });
	if (worktree) params.set("worktree", worktree);
	return apiUrl(`/api/files/download?${params.toString()}`);
}

/**
 * Failure carried by an error response body: `{"error": "...", "code": "..."}`.
 *
 * A response can also come from something between the browser and the handler —
 * a proxy, the relay tunnel, or the auth middleware, which answers in plain
 * text — so a body that is not that JSON is expected rather than exceptional,
 * and the status stands in for it.
 */
async function readError(response: Response): Promise<Error> {
	// A rejected token is the end of the session rather than of this download;
	// saying so and returning to login beats a banner naming a status code.
	if (logoutIfUnauthorized(response.status)) {
		return new Error("Your session has expired. Sign in again.");
	}

	const body = await response.text().catch(() => "");

	let code = "";
	let message = "";
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed !== null && typeof parsed === "object") {
			const fields = parsed as { error?: unknown; code?: unknown };
			if (typeof fields.error === "string") message = fields.error;
			if (typeof fields.code === "string") code = fields.code;
		}
	} catch {
		// Not JSON; fall through to the status below.
	}

	const known = ERROR_MESSAGES.get(code);
	if (known) return new Error(known);
	if (message) {
		// `internal` is a server fault the user cannot act on, so it keeps the
		// server's technical detail rather than being flattened to "try again".
		return new Error(
			code === "internal" ? `Server error: ${message}` : message,
		);
	}

	return new Error(`Download failed with HTTP ${response.status}`);
}

interface ContentRange {
	start: number;
	end: number;
	total: number;
}

/** `bytes 0-4194303/12345678` from a 206 response. */
function parseContentRange(header: string | null): ContentRange | null {
	const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");
	if (!match) return null;
	return {
		start: Number(match[1]),
		end: Number(match[2]),
		total: Number(match[3]),
	};
}

// The unsatisfied-range form of Content-Range, whose only number is the size
// the server measured, e.g. `bytes` `*` `/0` for an empty file.
function parseUnsatisfiedSize(header: string | null): number | null {
	const match = /^bytes\s+\*\/(\d+)$/.exec(header?.trim() ?? "");
	return match ? Number(match[1]) : null;
}

export interface DownloadRequest {
	path: string;
	/** Worktree name; empty for the main one. */
	worktree: string;
	signal?: AbortSignal;
}

/**
 * Reads a workspace file into a Blob, one `Range` request at a time.
 *
 * The endpoint is behind the auth middleware, so a bare `<a href download>`
 * cannot reach it — the bytes have to come through `fetch` and be handed to the
 * browser as an object URL.
 */
export async function fetchFileBlob({
	path,
	worktree,
	signal,
}: DownloadRequest): Promise<Blob> {
	const url = downloadUrl(path, worktree);
	const chunks: Blob[] = [];
	let offset = 0;
	let total: number | null = null;
	let modified: string | null = null;

	while (total === null || offset < total) {
		const headers: Record<string, string> = {
			...authHeaders(),
			Range: `bytes=${offset}-${offset + DOWNLOAD_CHUNK_SIZE - 1}`,
		};
		// Catches a file rewritten between chunks, which would otherwise be
		// spliced into a mixture of two versions and saved without a word.
		//
		// `If-Unmodified-Since` rather than `If-Range`: both detect it, but a
		// failed `If-Range` is answered with the whole new file, and one unbounded
		// response is the very thing chunking exists to avoid. This asks for a
		// `412` instead: a few bytes, and a failure that can be reported.
		if (modified) headers["If-Unmodified-Since"] = modified;

		const response = await fetch(url, { headers, signal });

		if (response.status === 412) throw new Error(CHANGED_MID_DOWNLOAD);

		if (response.status === 200) {
			// No partial content: an empty file, which no range can overlap, or
			// something between here and the handler that dropped the `Range`
			// header. Either way this body is one whole, self-consistent file, so
			// it replaces anything collected so far rather than extending it.
			return await response.blob();
		}

		if (response.status === 416) {
			const size = parseUnsatisfiedSize(response.headers.get("Content-Range"));
			// An empty file is the one case a range cannot be satisfied without
			// anything being wrong.
			if (size === 0) return new Blob([], { type: DOWNLOAD_MIME });
			if (size === null) {
				throw new Error(
					`The server refused the bytes from ${offset} onward without saying how large the file is.`,
				);
			}
			throw new Error(CHANGED_MID_DOWNLOAD);
		}

		if (response.status !== 206) throw await readError(response);

		const range = parseContentRange(response.headers.get("Content-Range"));
		if (!range) {
			throw new Error(
				"The server sent a partial response without a valid Content-Range.",
			);
		}
		if (total !== null && range.total !== total) {
			throw new Error(CHANGED_MID_DOWNLOAD);
		}
		// Where the bytes belong is the server's claim, not an assumption: appending
		// a chunk that starts somewhere else would save a plausible, corrupt file,
		// and a chunk that does not advance would loop here forever.
		if (range.start !== offset || range.end < offset) {
			throw new Error(
				`The server sent bytes ${range.start}-${range.end} when asked for ${offset} onward.`,
			);
		}

		chunks.push(await response.blob());
		total = range.total;
		// The server's own end, not the requested one: it is free to send less.
		offset = range.end + 1;
		// Kept if one response omits the header, since dropping the validator
		// would silently return the rest of the file to being spliceable.
		modified = response.headers.get("Last-Modified") ?? modified;
	}

	return new Blob(chunks, { type: DOWNLOAD_MIME });
}

/**
 * How long the object URL outlives the click that used it.
 *
 * WebKit reads a blob URL after the click handler has returned, so revoking in
 * the same task can hand the user a truncated file or nothing at all — and iOS
 * Safari is the browser this app is most used from. A second is far longer than
 * that read needs, and costs only a second of holding a Blob the browser needs
 * for the download anyway.
 */
const OBJECT_URL_LIFETIME_MS = 1000;

/** Hands a Blob to the browser under `fileName`. */
export function saveBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

/** Downloads a workspace file and saves it under its workspace name. */
export async function downloadFile(request: DownloadRequest): Promise<void> {
	const blob = await fetchFileBlob(request);
	// Aborting a fetch that has already settled does nothing, so the last chunk
	// can land after the user cancelled or left. Without this check, pressing
	// Cancel on the final stretch would still save the file.
	if (request.signal?.aborted) return;
	saveBlob(blob, splitPath(request.path).fileName);
}
