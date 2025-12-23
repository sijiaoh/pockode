import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiBaseUrl, getWebSocketUrl } from "./config";

describe("getApiBaseUrl", () => {
	it("returns window.location.origin when env is not set", () => {
		expect(getApiBaseUrl()).toBe(window.location.origin);
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
});
