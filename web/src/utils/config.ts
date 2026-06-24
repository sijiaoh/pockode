import { getWebSocketUrl as sharedGetWebSocketUrl } from "@pockode/shared";

export function getApiBaseUrl(): string {
	return import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
}

export function getWebSocketUrl(): string {
	return sharedGetWebSocketUrl(getApiBaseUrl());
}
