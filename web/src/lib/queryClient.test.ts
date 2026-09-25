import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock authStore
vi.mock("./authStore", () => ({
	authActions: {
		logout: vi.fn(),
	},
}));

describe("createQueryClient", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("retry behavior", () => {
		it("does not retry on 401", async () => {
			const { HttpError } = await import("./api");
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			const retryFn = queryClient.getDefaultOptions().queries?.retry;
			if (typeof retryFn !== "function") {
				throw new Error("retry should be a function");
			}

			expect(retryFn(0, new HttpError(401))).toBe(false);
			expect(retryFn(1, new HttpError(401))).toBe(false);
		});

		it("retries up to 3 times for other errors", async () => {
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			const retryFn = queryClient.getDefaultOptions().queries?.retry;
			if (typeof retryFn !== "function") {
				throw new Error("retry should be a function");
			}

			const genericError = new Error("Network error");
			expect(retryFn(0, genericError)).toBe(true);
			expect(retryFn(1, genericError)).toBe(true);
			expect(retryFn(2, genericError)).toBe(true);
			expect(retryFn(3, genericError)).toBe(false);
		});

		it("does not retry mutations", async () => {
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			expect(queryClient.getDefaultOptions().mutations?.retry).toBe(false);
		});
	});

	describe("global 401 handling", () => {
		it("calls logout on query 401", async () => {
			const { authActions } = await import("./authStore");
			const { HttpError } = await import("./api");
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			const queryCache = queryClient.getQueryCache();

			queryCache.notify({
				type: "updated",
				query: {
					state: { error: new HttpError(401) },
				},
			} as Parameters<typeof queryCache.notify>[0]);

			expect(authActions.logout).toHaveBeenCalled();
		});

		it("does not call logout on other HTTP errors", async () => {
			const { authActions } = await import("./authStore");
			const { HttpError } = await import("./api");
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			const queryCache = queryClient.getQueryCache();

			queryCache.notify({
				type: "updated",
				query: {
					state: { error: new HttpError(500) },
				},
			} as Parameters<typeof queryCache.notify>[0]);

			expect(authActions.logout).not.toHaveBeenCalled();
		});

		it("calls logout on mutation 401", async () => {
			const { authActions } = await import("./authStore");
			const { HttpError } = await import("./api");
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			const mutationCache = queryClient.getMutationCache();

			mutationCache.notify({
				type: "updated",
				mutation: {
					state: { error: new HttpError(401) },
				},
			} as Parameters<typeof mutationCache.notify>[0]);

			expect(authActions.logout).toHaveBeenCalled();
		});

		it("does not call logout on non-HttpError", async () => {
			const { authActions } = await import("./authStore");
			const { createQueryClient } = await import("./queryClient");
			const queryClient = createQueryClient();

			const mutationCache = queryClient.getMutationCache();

			mutationCache.notify({
				type: "updated",
				mutation: {
					state: { error: new Error("Network error") },
				},
			} as Parameters<typeof mutationCache.notify>[0]);

			expect(authActions.logout).not.toHaveBeenCalled();
		});
	});
});
