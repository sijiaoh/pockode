import { getApiBaseUrl, getWorkspaceBasePath } from "../utils/config";
import { authActions } from "./authStore";
import { workspaceActions } from "./workspaceStore";

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

/**
 * Fetch with authentication and optional workspace scoping.
 * In workspace mode, API paths are prefixed with /w/:id
 */
export async function fetchWithAuth(
	path: string,
	options: RequestInit = {},
): Promise<Response> {
	const token = authActions.getToken();
	const workspaceId = workspaceActions.getCurrentWorkspaceId();
	const workspacePath = getWorkspaceBasePath(workspaceId);
	const fullPath = workspacePath + path;

	const response = await fetch(`${getApiBaseUrl()}${fullPath}`, {
		...options,
		headers: {
			...options.headers,
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new HttpError(response.status, body);
	}

	return response;
}

/**
 * Fetch without workspace scoping for manager-level APIs.
 */
export async function fetchManagerApi(
	path: string,
	options: RequestInit = {},
): Promise<Response> {
	const token = authActions.getToken();

	const response = await fetch(`${getApiBaseUrl()}${path}`, {
		...options,
		headers: {
			...options.headers,
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new HttpError(response.status, body);
	}

	return response;
}
