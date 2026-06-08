import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./wsStore", () => ({
	wsActions: {
		disconnect: vi.fn(),
	},
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe("authStore", () => {
	beforeEach(() => {
		vi.resetModules();
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("initial state", () => {
		it("isAuthenticated is false initially", async () => {
			const { useAuthStore } = await import("./authStore");
			expect(useAuthStore.getState().isAuthenticated).toBe(false);
		});

		it("isLoading is true initially", async () => {
			const { useAuthStore } = await import("./authStore");
			expect(useAuthStore.getState().isLoading).toBe(true);
		});
	});

	describe("authActions", () => {
		it("login sets isAuthenticated to true on success", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ success: true }),
			});

			const { useAuthStore, authActions } = await import("./authStore");

			const result = await authActions.login("new-token");

			expect(result).toBe(true);
			expect(useAuthStore.getState().isAuthenticated).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/api/login"),
				expect.objectContaining({
					method: "POST",
					credentials: "include",
					body: JSON.stringify({ token: "new-token" }),
				}),
			);
		});

		it("login returns false on failure", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
			});

			const { useAuthStore, authActions } = await import("./authStore");

			const result = await authActions.login("invalid-token");

			expect(result).toBe(false);
			expect(useAuthStore.getState().isAuthenticated).toBe(false);
		});

		it("login returns false on network error", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network error"));

			const { useAuthStore, authActions } = await import("./authStore");

			const result = await authActions.login("token");

			expect(result).toBe(false);
			expect(useAuthStore.getState().isAuthenticated).toBe(false);
		});

		it("logout disconnects WebSocket and clears auth state", async () => {
			mockFetch.mockResolvedValue({ ok: true });

			const { wsActions } = await import("./wsStore");
			const { useAuthStore, authActions } = await import("./authStore");

			// First login
			await authActions.login("token");

			// Then logout
			await authActions.logout();

			expect(wsActions.disconnect).toHaveBeenCalled();
			expect(useAuthStore.getState().isAuthenticated).toBe(false);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/api/logout"),
				expect.objectContaining({
					method: "POST",
					credentials: "include",
				}),
			);
		});

		it("logout clears auth state even on network error", async () => {
			mockFetch
				.mockResolvedValueOnce({ ok: true }) // login succeeds
				.mockRejectedValueOnce(new Error("Network error")); // logout fails

			const { wsActions } = await import("./wsStore");
			const { useAuthStore, authActions } = await import("./authStore");

			await authActions.login("token");
			await authActions.logout();

			expect(wsActions.disconnect).toHaveBeenCalled();
			expect(useAuthStore.getState().isAuthenticated).toBe(false);
		});

		it("setAuthenticated updates state directly", async () => {
			const { useAuthStore, authActions } = await import("./authStore");

			authActions.setAuthenticated(true);
			expect(useAuthStore.getState().isAuthenticated).toBe(true);

			authActions.setAuthenticated(false);
			expect(useAuthStore.getState().isAuthenticated).toBe(false);
		});

		it("checkAuth sets isAuthenticated to true on 200 response", async () => {
			mockFetch.mockResolvedValueOnce({ ok: true });

			const { useAuthStore, authActions } = await import("./authStore");

			await authActions.checkAuth();

			expect(useAuthStore.getState().isAuthenticated).toBe(true);
			expect(useAuthStore.getState().isLoading).toBe(false);
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("/api/me"),
				expect.objectContaining({ credentials: "include" }),
			);
		});

		it("checkAuth sets isAuthenticated to false on 401 response", async () => {
			mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

			const { useAuthStore, authActions } = await import("./authStore");

			await authActions.checkAuth();

			expect(useAuthStore.getState().isAuthenticated).toBe(false);
			expect(useAuthStore.getState().isLoading).toBe(false);
		});

		it("checkAuth sets isAuthenticated to false on network error", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network error"));

			const { useAuthStore, authActions } = await import("./authStore");

			await authActions.checkAuth();

			expect(useAuthStore.getState().isAuthenticated).toBe(false);
			expect(useAuthStore.getState().isLoading).toBe(false);
		});
	});
});
