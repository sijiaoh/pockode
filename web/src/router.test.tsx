import { RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every route renders inside the shell, so a shell that throws stands for a
// throw on any page that nothing nearer caught.
vi.mock("./components/AppShell", () => ({
	default: () => {
		throw new Error("Invalid hunk header format");
	},
}));

describe("router", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("puts a way back to the start in place of a page that threw", async () => {
		window.history.replaceState(null, "", "/unstaged/a.txt");
		const { router } = await import("./router");
		render(<RouterProvider router={router} />);

		expect(
			await screen.findByRole("button", { name: "Go to project" }),
		).toBeTruthy();
		expect(screen.getByText("Invalid hunk header format")).toBeTruthy();
	});

	// The trail writes the page it starts on into sessionStorage as it is
	// created; a ticket still in the address then would outlive the page.
	it("takes a login ticket out of the address before the trail sees it", async () => {
		vi.resetModules();
		sessionStorage.clear();
		// An entry the router has numbered, as after a reload, or the trail
		// records nothing and the test proves nothing.
		window.history.replaceState(
			{ __TSR_index: 0, __TSR_key: "opened" },
			"",
			"/w/main#login_ticket=the-ticket",
		);

		// Every write, not what is left at the end: the trail rewrites itself as
		// the router settles, which would hide a ticket it held for a moment.
		const writes: string[] = [];
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
			this: Storage,
			key,
			value,
		) {
			writes.push(`${key}=${value}`);
		});

		await import("./router");
		const { authActions } = await import("./lib/authStore");

		expect(window.location.href).not.toContain("the-ticket");
		expect(writes.some((w) => w.startsWith("pockode:history-trail="))).toBe(
			true,
		);
		expect(writes.filter((w) => w.includes("the-ticket"))).toEqual([]);
		expect(authActions.getCredential()).toEqual({
			kind: "login_ticket",
			value: "the-ticket",
			sessionToken: null,
		});
	});
});
