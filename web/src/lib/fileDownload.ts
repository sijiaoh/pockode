import { apiUrl, logoutIfUnauthorized } from "./api";

/**
 * What the endpoint sends, and what every saved Blob is typed as (`saveBlob`).
 *
 * A Blob with no type is handled inconsistently by iOS Safari, which may show
 * it inline instead of saving it — and a phone is where this app is most used.
 * A Blob under its real type is worse: its object URL is same-origin with the
 * app, so an SVG or HTML file shown inline would run its scripts as the app.
 */
export const DOWNLOAD_MIME = "application/octet-stream";

/** Asks the raw endpoint for an attachment (`filetransfer.RawDownloadParam`). */
const RAW_DOWNLOAD_PARAM = "download";

/**
 * Server error codes phrased for the user; unlisted ones keep the server's own
 * message. A Map rather than an object literal because the key is whatever the
 * response says, and an object would answer for `toString` as readily as for a
 * code that exists.
 */
export type ErrorMessages = ReadonlyMap<string, string>;

/** The wording for a file. */
const ERROR_MESSAGES: ErrorMessages = new Map([
	["invalid_path", "Invalid file path"],
	["not_a_file", "This path is not a regular file"],
	["not_found", "File not found — it may have been moved or deleted"],
	["worktree_not_found", "Worktree not found"],
	// What a raw capability for one file answers when the file is a link out
	// of the project, which a capability never follows, or cannot be opened.
	[
		"outside_scope",
		"This file can't be read from here — it may link to outside the project, or not be readable",
	],
]);

/**
 * `ERROR_MESSAGES` for a folder saved as a zip archive. `invalid_path` keeps
 * the server's message, which says what is wrong — a name inside that would
 * unpack outside the folder on Windows, a folder linking out of the project —
 * where a file's is only ever a bad path. Too large, too many entries and a
 * file changed mid-read are worded by the server with the limit it applied.
 */
export const FOLDER_ERROR_MESSAGES: ErrorMessages = new Map([
	["not_found", "Folder not found — it may have been moved or deleted"],
	["worktree_not_found", "Worktree not found"],
]);

export function downloadUrl(path: string, worktree: string): string {
	const params = new URLSearchParams({ path });
	if (worktree) params.set("worktree", worktree);
	return apiUrl(`/api/files/download?${params.toString()}`);
}

/** Where a file's bytes are read from as commit `hash` left it. */
export function commitFileUrl(
	hash: string,
	path: string,
	worktree: string,
): string {
	const params = new URLSearchParams({ hash, path });
	if (worktree) params.set("worktree", worktree);
	return apiUrl(`/api/git/show/file?${params.toString()}`);
}

/**
 * Failure carried by an error response body: `{"error": "...", "code": "..."}`.
 *
 * A response can also come from something between the browser and the handler —
 * a proxy, the relay tunnel, or the auth middleware, which answers in plain
 * text — so a body that is not that JSON is expected rather than exceptional,
 * and the status stands in for it.
 */
export async function readError(
	response: Response,
	messages: ErrorMessages = ERROR_MESSAGES,
): Promise<Error> {
	// A rejected credential is the end of the session rather than of this download;
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

	const known = messages.get(code);
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

/** Hands a Blob to the browser under `fileName`, typed `DOWNLOAD_MIME`. */
export function saveBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(
		blob.type === DOWNLOAD_MIME
			? blob
			: blob.slice(0, blob.size, DOWNLOAD_MIME),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

/**
 * `url`, absolute, asking the raw endpoint to answer as an attachment
 * (`Content-Disposition: attachment`): what the browser saves from rather than
 * opens.
 */
export function attachmentUrl(url: string): string {
	const target = new URL(url, window.location.href);
	target.searchParams.set(RAW_DOWNLOAD_PARAM, "1");
	return target.href;
}

/**
 * Has the browser download `url` to disk as it arrives, never holding it in
 * memory — for files that may be far larger than a Blob should be. The URL
 * must carry its own credential (a raw capability). It is asked for as an
 * attachment, so a browser that ignores `download` — a cross-origin URL, a
 * type it would rather preview — still saves it rather than opening it; only
 * a same-origin one takes `fileName` from the link, the rest the URL's own. An
 * empty `fileName` leaves the name to the response's `Content-Disposition`.
 *
 * The browser owns the transfer from here: nothing is reported back, so a
 * caller that has to report failures checks the URL first (`saveCheckedUrl`).
 */
export function saveUrl(url: string, fileName: string): void {
	const link = document.createElement("a");
	link.href = attachmentUrl(url);
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
}
