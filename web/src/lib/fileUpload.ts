import type { Entry } from "../types/contents";
import { formatBytes } from "../utils/bytes";
import { apiUrl, authHeaders, logoutIfUnauthorized } from "./api";

/**
 * What a destination listing says about a name that is about to be written.
 *
 * `folder` is anything the endpoint refuses to replace even with `overwrite`.
 * The server answers `409 conflict` for a folder exactly as it does for a file,
 * so telling the two apart — and keeping a file from being aimed at a folder —
 * has to happen here, from the directory listing the tree already holds.
 */
export type NameCollision = "none" | "file" | "folder";

/**
 * Server error codes phrased for the user; unlisted ones keep the server's own
 * message. A Map rather than an object literal because the key is whatever the
 * response says, and an object would answer for `toString` as readily as for a
 * code that exists.
 */
const ERROR_MESSAGES = new Map([
	["invalid_path", "Invalid path"],
	["invalid_request", "The upload was cut short"],
	["not_a_directory", "The destination is not a folder"],
	["not_found", "The destination folder no longer exists"],
	["worktree_not_found", "Worktree not found"],
]);

/**
 * A `409` in the server's own words, minus the half addressed to an API caller.
 *
 * `conflict` is not phrased here like the codes above are, because the server
 * knows something this side cannot: it ran `Lstat`, so it alone can say the
 * name belongs to a directory. Flattening that to "Already exists" leaves the
 * user pressing Replace on something the endpoint will refuse again for the
 * same reason, with no way to find out why.
 *
 * What does not carry over is `retry with overwrite=true`: a query parameter is
 * not an action anyone can take from the queue, and the two buttons beside the
 * message already are.
 */
function conflictMessage(serverMessage: string): string {
	const trimmed = serverMessage.replace(
		/;\s*retry with overwrite=true.*$/i,
		"",
	);
	return trimmed || "Already exists";
}

/**
 * Failures that sending the identical request again cannot get past.
 *
 * `too_large` cannot pass on a second attempt: the same file is the same size,
 * and the ceiling is the endpoint's. A `conflict` is offered its own two
 * resolutions instead of a plain retry.
 */
const TERMINAL_CODES = new Set(["too_large", "conflict"]);

/** A failure the endpoint described in its `{error, code}` body. */
export class UploadError extends Error {
	readonly code: string;
	/** How many files this same request stored before it failed (`written`). */
	readonly storedCount: number;
	readonly canRetry: boolean;

	constructor(
		message: string,
		options: { code?: string; storedCount?: number; canRetry?: boolean } = {},
	) {
		super(message);
		this.name = "UploadError";
		this.code = options.code ?? "";
		this.storedCount = options.storedCount ?? 0;
		this.canRetry = options.canRetry ?? true;
	}
}

/** Raised when the caller's signal fires; named so `isAbortError` sees it. */
class UploadAbortError extends Error {
	constructor() {
		super("Upload cancelled");
		this.name = "AbortError";
	}
}

function uploadUrl(
	destPath: string,
	overwrite: boolean,
	worktree: string,
): string {
	const params = new URLSearchParams();
	// An absent `path` already means the workspace root, and an absent
	// `overwrite` already means false; sending them empty says nothing more.
	if (destPath) params.set("path", destPath);
	if (overwrite) params.set("overwrite", "true");
	if (worktree) params.set("worktree", worktree);
	const query = params.toString();
	return apiUrl(`/api/files/upload${query ? `?${query}` : ""}`);
}

interface ErrorBody {
	error: string;
	code: string;
	limit: number | null;
	storedCount: number;
}

/**
 * Reads the contract body out of a response.
 *
 * A response can also come from something between the browser and the handler —
 * a proxy, the relay tunnel, or the auth middleware, which answers in plain
 * text — so a body that is not that JSON is expected rather than exceptional.
 */
function parseErrorBody(text: string): ErrorBody {
	const empty: ErrorBody = {
		error: "",
		code: "",
		limit: null,
		storedCount: 0,
	};

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return empty;
	}
	if (parsed === null || typeof parsed !== "object") return empty;

	const fields = parsed as {
		error?: unknown;
		code?: unknown;
		limit?: unknown;
		written?: unknown;
	};
	return {
		error: typeof fields.error === "string" ? fields.error : "",
		code: typeof fields.code === "string" ? fields.code : "",
		limit: typeof fields.limit === "number" ? fields.limit : null,
		storedCount: Array.isArray(fields.written) ? fields.written.length : 0,
	};
}

function toUploadError(status: number, text: string): UploadError {
	// A rejected token is the end of the session rather than of this upload;
	// saying so and returning to login beats a banner naming a status code.
	if (logoutIfUnauthorized(status)) {
		return new UploadError("Your session has expired. Sign in again.", {
			canRetry: false,
		});
	}

	const body = parseErrorBody(text);
	const canRetry = !TERMINAL_CODES.has(body.code);

	// The ceiling comes back with the refusal so the message can name it
	// without a second copy of the number (see docs/file.md#transfer).
	if (body.code === "too_large") {
		const limit =
			body.limit === null ? "" : ` (max ${formatBytes(body.limit)})`;
		return new UploadError(`Too large${limit}`, {
			code: body.code,
			storedCount: body.storedCount,
			canRetry,
		});
	}

	const rest = {
		code: body.code,
		storedCount: body.storedCount,
		canRetry,
	};

	if (body.code === "conflict") {
		return new UploadError(conflictMessage(body.error), rest);
	}

	const known = ERROR_MESSAGES.get(body.code);
	if (known) return new UploadError(known, rest);
	if (body.error) {
		// `internal` is a server fault the user cannot act on, so it keeps the
		// server's technical detail rather than being flattened to "try again".
		const message =
			body.code === "internal" ? `Server error: ${body.error}` : body.error;
		return new UploadError(message, rest);
	}

	return new UploadError(`Upload failed with HTTP ${status}`, rest);
}

export interface UploadRequest {
	file: File;
	/** Name to store it under; differs from `file.name` after "Keep both". */
	name: string;
	/** Destination directory relative to the workspace root; empty is the root. */
	destPath: string;
	/** Worktree name; empty for the main one. */
	worktree: string;
	overwrite: boolean;
	/** Fraction of the body sent so far, 0 to 1. */
	onProgress?: (fraction: number) => void;
	signal?: AbortSignal;
}

/**
 * Sends one file to the upload endpoint.
 *
 * One request per file, though the endpoint accepts any number of parts:
 * progress is reported for a request as a whole and could not be attributed to
 * a file within it, `overwrite` applies to the whole request so a mixed
 * decision has to be split anyway, and a failure then belongs to the one file
 * it is shown against.
 *
 * `XMLHttpRequest` rather than `fetch`: `fetch` reports nothing while a request
 * body is being sent, and a progress bar is the point of a queue.
 */
export function uploadFile(request: UploadRequest): Promise<void> {
	const { file, name, destPath, worktree, overwrite, onProgress, signal } =
		request;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new UploadAbortError());
			return;
		}

		const body = new FormData();
		body.append("file", file, name);

		const xhr = new XMLHttpRequest();
		xhr.open("POST", uploadUrl(destPath, overwrite, worktree));
		for (const [header, value] of Object.entries(authHeaders())) {
			xhr.setRequestHeader(header, value);
		}

		const abort = () => xhr.abort();
		signal?.addEventListener("abort", abort);
		const settle = (finish: () => void) => {
			signal?.removeEventListener("abort", abort);
			finish();
		};

		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0) {
				onProgress?.(event.loaded / event.total);
			}
		};

		xhr.onload = () =>
			settle(() => {
				if (xhr.status === 200) {
					resolve();
					return;
				}
				reject(toUploadError(xhr.status, xhr.responseText));
			});

		// The browser reports a dropped connection, a DNS failure and a blocked
		// request identically and without a status, so this is all that can be
		// said about it.
		xhr.onerror = () =>
			settle(() => reject(new UploadError("Connection lost")));
		xhr.ontimeout = () =>
			settle(() => reject(new UploadError("The upload timed out")));
		xhr.onabort = () => settle(() => reject(new UploadAbortError()));

		xhr.send(body);
	});
}

/** What uploading `name` into a directory whose listing is `entries` would hit. */
export function nameCollision(
	name: string,
	entries: Entry[] | null,
): NameCollision {
	// Nothing cached to check against: the `409` is the backstop, and guessing
	// "taken" here would block an upload that has nothing in its way.
	if (!entries) return "none";
	const existing = entries.find((entry) => entry.name === name);
	if (!existing) return "none";
	return existing.type === "dir" ? "folder" : "file";
}

/**
 * `logo.png` -> `logo (1).png`, the name "Keep both" stores a file under.
 *
 * The endpoint cannot rename, so a second copy is a matter of choosing the name
 * before sending rather than asking the server for one.
 */
export function nextAvailableName(name: string, taken: Set<string>): string {
	if (!taken.has(name)) return name;

	const dot = name.lastIndexOf(".");
	// `> 0`, not `>= 0`: a leading dot is the whole name of a dotfile rather
	// than an extension, so `.env` becomes `.env (1)` and not ` (1).env`.
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	// A name that is itself a copy counts from where it left off, so a second
	// pass over `logo (1).png` yields `logo (2).png` and not `logo (1) (1).png`.
	// Only when it collides: a file genuinely named `logo (1).png` with nothing
	// in its way never reaches here.
	const base = stem.replace(/ \(\d+\)$/, "");

	// One of the first `taken.size + 1` suffixes is free, so this always ends
	// with an answer rather than looping on a name it can never place.
	for (let n = 1; n <= taken.size; n++) {
		const candidate = `${base} (${n})${extension}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base} (${taken.size + 1})${extension}`;
}
