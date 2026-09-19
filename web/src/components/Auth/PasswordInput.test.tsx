import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PasswordInput from "./PasswordInput";

describe("PasswordInput", () => {
	// A password typed on a phone keyboard collects a trailing space from
	// autocorrect often enough that sending it verbatim would read as a wrong
	// password with nothing on screen to explain it.
	it("submits the password without surrounding whitespace", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(<PasswordInput onSubmit={onSubmit} />);

		await user.type(screen.getByLabelText(/password/i), "  hunter2  ");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(onSubmit).toHaveBeenCalledWith("hunter2");
	});

	// Being turned away is the only way a wrong password is discoverable, so the
	// screen the user is sent back to has to say it happened.
	it("shows why the last attempt was refused", () => {
		render(<PasswordInput onSubmit={vi.fn()} error="Authentication failed" />);

		expect(screen.getByText("Authentication failed")).toBeInTheDocument();
	});
});
