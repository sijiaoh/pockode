import { getApiBaseUrl } from "../utils/config";
import { authActions } from "./authStore";

export class HttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body = "") {
		super(body ? `HTTP ${status}: ${body}` : `HTTP ${status}`);
		this.name = "HttpError";
		this.status = status;
		this.body = body;
	}
}

/** Absolute URL for an API path, e.g. `/api/files/download?path=a.txt`. */
export function apiUrl(path: string): string {
	return `${getApiBaseUrl()}${path}`;
}

/**
 * Bearer header for the API. Every endpoint is behind the auth middleware, so
 * transfers that cannot use `fetchWithAuth` — a download needs the raw response
 * rather than a JSON one — still authenticate through this single place.
 */
export function authHeaders(): Record<string, string> {
	return { Authorization: `Bearer ${authActions.getToken()}` };
}

/**
 * Ends the session when the server rejects the token.
 *
 * A rejected token is not one request's problem: every other call would fail
 * the same way, so the app returns to the login screen instead of reporting a
 * failure the user cannot act on. Queries reach the same outcome through the
 * query cache subscriber in `queryClient.ts`; requests that bypass react-query
 * call this themselves.
 */
export function logoutIfUnauthorized(status: number): boolean {
	if (status !== 401) return false;
	authActions.logout();
	return true;
}

/**
 * True for the rejection a cancelled transfer produces.
 *
 * `fetch` rejects with a `DOMException` named `AbortError`; `XMLHttpRequest`
 * has no rejection of its own, so `fileUpload` raises an error under the same
 * name. Callers only ever need to know that the user did this on purpose.
 */
export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export async function fetchWithAuth(
	path: string,
	options: RequestInit = {},
): Promise<Response> {
	const response = await fetch(apiUrl(path), {
		...options,
		headers: {
			...options.headers,
			...authHeaders(),
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new HttpError(response.status, body);
	}

	return response;
}
