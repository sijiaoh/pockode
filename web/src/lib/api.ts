import { getApiBaseUrl } from "../utils/config";

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

export async function fetchWithAuth(
	path: string,
	options: RequestInit = {},
): Promise<Response> {
	const response = await fetch(`${getApiBaseUrl()}${path}`, {
		...options,
		headers: {
			...options.headers,
			"Content-Type": "application/json",
		},
		credentials: "include",
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new HttpError(response.status, body);
	}

	return response;
}
