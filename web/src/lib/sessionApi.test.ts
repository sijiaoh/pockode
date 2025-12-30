import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./api";
import {
	createSession,
	deleteSession,
	getHistory,
	listSessions,
	updateSessionTitle,
} from "./sessionApi";

// Mock config
vi.mock("../utils/config", () => ({
	getApiBaseUrl: vi.fn(() => "http://localhost:8080"),
}));

// Mock authStore
vi.mock("./authStore", () => ({
	authActions: {
		getToken: vi.fn(() => "test-token"),
	},
}));

describe("sessionApi", () => {
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

	describe("listSessions", () => {
		it("fetches sessions with auth header", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						sessions: [
							{ id: "1", title: "Test", created_at: "", updated_at: "" },
						],
					}),
			} as Response);

			const sessions = await listSessions();

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:8080/api/sessions",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer test-token",
					}),
				}),
			);
			expect(sessions).toEqual([
				{ id: "1", title: "Test", created_at: "", updated_at: "" },
			]);
		});

		it("throws HttpError on 401", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 401,
				text: () => Promise.resolve("Unauthorized"),
			} as Response);

			const error = await listSessions().catch((e) => e);
			expect(error).toBeInstanceOf(HttpError);
			expect(error.status).toBe(401);
		});
	});

	describe("createSession", () => {
		it("creates session with POST method", async () => {
			const newSession = {
				id: "new-id",
				title: "New Chat",
				created_at: "",
				updated_at: "",
			};
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(newSession),
			} as Response);

			const result = await createSession();

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:8080/api/sessions",
				expect.objectContaining({
					method: "POST",
				}),
			);
			expect(result).toEqual(newSession);
		});
	});

	describe("deleteSession", () => {
		it("deletes session with DELETE method", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({}),
			} as Response);

			await deleteSession("session-123");

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:8080/api/sessions/session-123",
				expect.objectContaining({
					method: "DELETE",
				}),
			);
		});

		it("throws HttpError on server error", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Internal Server Error"),
			} as Response);

			const error = await deleteSession("123").catch((e) => e);
			expect(error).toBeInstanceOf(HttpError);
			expect(error.status).toBe(500);
		});
	});

	describe("updateSessionTitle", () => {
		it("updates title with PATCH method", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({}),
			} as Response);

			await updateSessionTitle("session-123", "New Title");

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:8080/api/sessions/session-123",
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({ title: "New Title" }),
				}),
			);
		});
	});

	describe("getHistory", () => {
		it("fetches history for session", async () => {
			const mockHistory = [
				{ type: "message", content: "hello" },
				{ type: "text", content: "world" },
			];
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ history: mockHistory }),
			} as Response);

			const history = await getHistory("session-123");

			expect(fetch).toHaveBeenCalledWith(
				"http://localhost:8080/api/sessions/session-123/history",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer test-token",
					}),
				}),
			);
			expect(history).toEqual(mockHistory);
		});
	});
});
