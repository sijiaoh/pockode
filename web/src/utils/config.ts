export function getApiBaseUrl(): string {
	return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

/**
 * Get the workspace-specific base URL for API calls.
 * Returns empty string if not in workspace mode.
 */
export function getWorkspaceBasePath(workspaceId: string | null): string {
	if (!workspaceId) return "";
	return `/w/${workspaceId}`;
}

/**
 * Get the WebSocket URL for a workspace.
 * In workspace mode, connects to /w/:id/ws
 * In single mode, connects to /ws
 */
export function getWebSocketUrl(workspaceId?: string | null): string {
	const baseUrl = getApiBaseUrl();
	const wsProtocol = baseUrl.startsWith("https") ? "wss" : "ws";
	const host = baseUrl.replace(/^https?:\/\//, "");
	const wsPath = workspaceId ? `/w/${workspaceId}/ws` : "/ws";
	return `${wsProtocol}://${host}${wsPath}`;
}
