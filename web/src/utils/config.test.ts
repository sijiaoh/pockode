import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiBaseUrl, getWebSocketUrl } from "./config";

describe("getApiBaseUrl", () => {
	it("returns default URL when env is not set", () => {
		expect(getApiBaseUrl()).toBe("http://localhost:8080");
	});
});

describe("getWebSocketUrl", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("converts http to ws protocol", () => {
		const url = getWebSocketUrl();
		expect(url).toBe("ws://localhost:8080/ws");
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
