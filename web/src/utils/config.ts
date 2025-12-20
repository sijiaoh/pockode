// API configuration

export function getApiBaseUrl(): string {
	return import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";
}

export function getWebSocketUrl(): string {
	const baseUrl = getApiBaseUrl();
	const wsProtocol = baseUrl.startsWith("https") ? "wss" : "ws";
	const host = baseUrl.replace(/^https?:\/\//, "");
	return `${wsProtocol}://${host}/ws`;
}

export function getToken(): string {
	return (
		import.meta.env.VITE_AUTH_TOKEN ?? localStorage.getItem("auth_token") ?? ""
	);
}
