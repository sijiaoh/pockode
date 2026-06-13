import { getWebSocketUrl as sharedGetWebSocketUrl } from "@pockode/shared";

export function getApiBaseUrl(): string {
	return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

/**
 * Constructs a WebSocket URL with optional worktree query parameter.
 */
export function getWebSocketUrl(worktree?: string): string {
	const baseWsUrl = sharedGetWebSocketUrl(getApiBaseUrl());
	if (worktree) {
		return `${baseWsUrl}?worktree=${encodeURIComponent(worktree)}`;
	}
	return baseWsUrl;
}
