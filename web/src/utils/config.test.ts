import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiBaseUrl, getWebSocketUrl, getWorkspaceBasePath } from "./config";

describe("getApiBaseUrl", () => {
	it("returns window.location.origin when env is not set", () => {
		expect(getApiBaseUrl()).toBe(window.location.origin);
	});
});

describe("getWorkspaceBasePath", () => {
	it("returns empty string for null workspaceId", () => {
		expect(getWorkspaceBasePath(null)).toBe("");
	});

	it("returns workspace path for valid workspaceId", () => {
		expect(getWorkspaceBasePath("ws-123")).toBe("/w/ws-123");
	});
});

describe("getWebSocketUrl", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("converts http to ws protocol", () => {
		const url = getWebSocketUrl();
		const expectedOrigin = window.location.origin.replace(/^http/, "ws");
		expect(url).toBe(`${expectedOrigin}/ws`);
	});

	it("converts https to wss protocol", () => {
		vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com");
		expect(getWebSocketUrl()).toBe("wss://api.example.com/ws");
	});

	it("handles URL with port", () => {
		vi.stubEnv("VITE_API_BASE_URL", "http://localhost:3000");
		expect(getWebSocketUrl()).toBe("ws://localhost:3000/ws");
	});

	it("includes workspace path when workspaceId is provided", () => {
		vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8080");
		expect(getWebSocketUrl("ws-123")).toBe("ws://localhost:8080/w/ws-123/ws");
	});

	it("returns default path when workspaceId is null", () => {
		vi.stubEnv("VITE_API_BASE_URL", "http://localhost:8080");
		expect(getWebSocketUrl(null)).toBe("ws://localhost:8080/ws");
	});
});
