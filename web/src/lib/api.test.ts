import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithAuth, HttpError } from "./api";

vi.mock("../utils/config", () => ({
	getApiBaseUrl: vi.fn(() => "http://localhost:8080"),
}));

describe("api", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve({}),
				}),
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("fetchWithAuth", () => {
		it("uses credentials include for cookie auth", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
			} as Response);

			await fetchWithAuth("/api/test");

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:8080/api/test",
				expect.objectContaining({
					credentials: "include",
					headers: expect.objectContaining({
						"Content-Type": "application/json",
					}),
				}),
			);
		});

		it("throws HttpError when response is not ok", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: () => Promise.resolve("Unauthorized"),
			} as Response);

			const error = await fetchWithAuth("/api/test").catch((e) => e);
			expect(error).toBeInstanceOf(HttpError);
			expect(error.status).toBe(401);
		});

		it("returns response on success", async () => {
			const mockResponse = { ok: true } as Response;
			vi.mocked(fetch).mockResolvedValueOnce(mockResponse);

			const result = await fetchWithAuth("/api/test");

			expect(result).toBe(mockResponse);
		});
	});
});
