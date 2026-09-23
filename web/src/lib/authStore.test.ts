import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same as wsStore/queryClient: the dynamic import of the module under test is
// what outruns the 5s default under load, not anything these cases wait for.
describe("authStore", { timeout: 20_000 }, () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("initial state", () => {
		it("restores the session token from storage", async () => {
			localStorage.setItem("auth_session_token", "stored-session");

			const { useAuthStore } = await import("./authStore");
			expect(useAuthStore.getState().sessionToken).toBe("stored-session");
		});

		it("starts with no credential when storage is empty", async () => {
			const { useAuthStore, authActions } = await import("./authStore");

			expect(useAuthStore.getState().sessionToken).toBeNull();
			expect(authActions.getCredential()).toBeNull();
		});

		// The password used to be what was stored. An install that still has one
		// sitting in localStorage must not keep carrying it.
		it("wipes a password left behind by an older version", async () => {
			localStorage.setItem("auth_token", "the-users-password");

			await import("./authStore");

			expect(localStorage.getItem("auth_token")).toBeNull();
		});
	});

	describe("authActions", () => {
		it("keeps the typed password out of storage", async () => {
			const { useAuthStore, authActions } = await import("./authStore");

			authActions.login("hunter2");

			expect(useAuthStore.getState().password).toBe("hunter2");
			expect(localStorage.getItem("auth_session_token")).toBeNull();
			expect(authActions.getCredential()).toEqual({
				kind: "password",
				value: "hunter2",
			});
		});

		it("replaces the password with the issued session token", async () => {
			const { useAuthStore, authActions } = await import("./authStore");

			authActions.login("hunter2");
			authActions.rememberSession("issued-session");

			expect(localStorage.getItem("auth_session_token")).toBe("issued-session");
			expect(useAuthStore.getState().password).toBeNull();
			expect(authActions.getCredential()).toEqual({
				kind: "session_token",
				value: "issued-session",
			});
			expect(authActions.getBearer()).toBe("issued-session");
		});

		// Dropping a lapsed token leaves nothing behind to connect with: the
		// password it was exchanged for is long gone, so the user is back at the
		// password screen rather than silently retrying with a stale secret.
		it("forgetSession drops the stored token", async () => {
			const { useAuthStore, authActions } = await import("./authStore");

			authActions.login("hunter2");
			authActions.rememberSession("issued-session");
			authActions.forgetSession();

			expect(localStorage.getItem("auth_session_token")).toBeNull();
			expect(useAuthStore.getState().sessionToken).toBeNull();
			expect(authActions.getCredential()).toBeNull();
		});

		it("logout clears both credentials", async () => {
			const { useAuthStore, authActions } = await import("./authStore");

			authActions.login("hunter2");
			authActions.rememberSession("issued-session");
			authActions.logout();

			expect(localStorage.getItem("auth_session_token")).toBeNull();
			expect(useAuthStore.getState()).toMatchObject({
				sessionToken: null,
				password: null,
			});
			expect(authActions.getBearer()).toBe("");
		});
	});
});
