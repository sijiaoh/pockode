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
});
