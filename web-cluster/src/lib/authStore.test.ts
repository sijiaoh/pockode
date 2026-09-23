import { beforeEach, describe, expect, it, vi } from "vitest";

// Same as web's authStore test: the dynamic import of the module under test is
// what outruns the 5s default under load, not anything these cases wait for.
describe("cluster authStore", { timeout: 20_000 }, () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
	});

	// The contract of this whole change: the cluster panel authenticates with
	// what is in the tab and nothing else, so every load starts at the password
	// screen. A token in storage would quietly restore the old behaviour for
	// whoever still had one.
	it("writes no credential to storage", async () => {
		const { authActions } = await import("./authStore");

		authActions.login("hunter2");
		authActions.rememberSession("issued-session");

		expect(localStorage.length).toBe(0);
	});

	it("starts with no credential however the tab was opened", async () => {
		const { authActions } = await import("./authStore");

		expect(authActions.getCredential()).toBeNull();
	});

	// Not writing one from now on does not unwrite the one an earlier version
	// left behind, and this start is the only chance to remove it. The older
	// key held the user's password in the clear.
	it("clears credentials an earlier version stored", async () => {
		localStorage.setItem("cluster_auth_session_token", "stored-session");
		localStorage.setItem("cluster_auth_token", "the-users-password");

		const { authActions } = await import("./authStore");

		expect(localStorage.getItem("cluster_auth_session_token")).toBeNull();
		expect(localStorage.getItem("cluster_auth_token")).toBeNull();
		expect(authActions.getCredential()).toBeNull();
	});

	// A reload is a fresh module, so "survives a reload" is exactly "was read
	// back from storage on import" — asserted by re-importing after a session
	// was issued into the previous instance.
	it("does not carry a session into the next load", async () => {
		const first = await import("./authStore");
		first.authActions.rememberSession("issued-session");

		vi.resetModules();
		const second = await import("./authStore");

		expect(second.authActions.getCredential()).toBeNull();
	});
});
