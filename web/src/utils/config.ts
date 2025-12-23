// API configuration

export function getApiBaseUrl(): string {
	return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

export function getWebSocketUrl(): string {
	const baseUrl = getApiBaseUrl();
	const wsProtocol = baseUrl.startsWith("https") ? "wss" : "ws";
	const host = baseUrl.replace(/^https?:\/\//, "");
	return `${wsProtocol}://${host}/ws`;
}

export function getToken(): string {
	return localStorage.getItem("auth_token") ?? "";
}

export function saveToken(token: string): void {
	localStorage.setItem("auth_token", token);
}

export function clearToken(): void {
	localStorage.removeItem("auth_token");
}
