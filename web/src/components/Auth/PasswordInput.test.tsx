import { act, fireEvent, render, screen } from "@testing-library/react";
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

	// Every password is refused until the server's wait is over, the right one
	// included, so a submit before then would only read as a wrong password.
	// fireEvent rather than userEvent: the clock is frozen (see docs/testing.md).
	it("holds off submitting until the rate limit has passed", () => {
		vi.useFakeTimers();
		try {
			const onSubmit = vi.fn();
			render(<PasswordInput onSubmit={onSubmit} retryAt={Date.now() + 2000} />);
			fireEvent.change(screen.getByLabelText(/password/i), {
				target: { value: "hunter2" },
			});

			expect(screen.getByText(/try again in 2 seconds/i)).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();

			act(() => vi.advanceTimersByTime(1000));
			expect(screen.getByText(/try again in 1 second\b/i)).toBeInTheDocument();

			act(() => vi.advanceTimersByTime(1000));
			expect(screen.queryByText(/try again/i)).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Connect" }));
			expect(onSubmit).toHaveBeenCalledWith("hunter2");
		} finally {
			vi.useRealTimers();
		}
	});
});
