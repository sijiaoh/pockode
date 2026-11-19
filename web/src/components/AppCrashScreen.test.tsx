import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppCrashScreen from "./AppCrashScreen";

describe("AppCrashScreen", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("says what failed and leaves the failed page for the start page", async () => {
		const user = userEvent.setup();
		const replace = vi.fn();
		vi.stubGlobal("location", {
			...window.location,
			pathname: "/w/wt/unstaged/a.txt",
			replace,
		});
		render(
			<AppCrashScreen
				error={new Error("Invalid hunk header format")}
				reset={() => {}}
			/>,
		);

		expect(screen.getByText("Invalid hunk header format")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Go to project" }));
		expect(replace).toHaveBeenCalledWith("/w/wt/");
	});
});
