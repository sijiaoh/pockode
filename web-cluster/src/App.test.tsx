import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const wsState = {
	status: "disconnected",
	errorMessage: null as string | null,
	version: null as string | null,
	reauthReason: null as "session_expired" | null,
	actions: {
		connect: vi.fn(),
		disconnect: vi.fn(),
		retryNow: vi.fn(),
		listNodes: vi.fn(),
	},
};

vi.mock("./lib/wsStore", () => ({ useWSStore: () => wsState }));
vi.mock("./lib/authStore", () => ({
	authActions: { login: vi.fn(), logout: vi.fn() },
}));

afterEach(() => {
	wsState.status = "disconnected";
	wsState.errorMessage = null;
	wsState.version = null;
	wsState.reauthReason = null;
	window.history.replaceState({}, "", "/");
	vi.clearAllMocks();
});

describe("the password screen", () => {
	// A cluster password is long and random and usually typed on a phone
	// keyboard. Typing it blind is the single worst moment in this product, and
	// a wrong character is only discoverable by being turned away.
	it("lets the password be read back", async () => {
		const user = userEvent.setup();
		render(<App />);

		const field = screen.getByLabelText("Password");
		expect(field).toHaveAttribute("type", "password");

		await user.click(screen.getByRole("button", { name: "Show password" }));
		expect(field).toHaveAttribute("type", "text");

		await user.click(screen.getByRole("button", { name: "Hide password" }));
		expect(field).toHaveAttribute("type", "password");
	});

	// Asserted through the field's accessible description rather than as loose
	// text on the page: the answer is only useful to someone who is being asked
	// the question, and the wiring that delivers it is the part that rots.
	it("says where the password comes from and that it will be asked again", () => {
		render(<App />);

		const field = screen.getByLabelText("Password");
		expect(field).toHaveAccessibleDescription(/--password/);
		expect(field).toHaveAccessibleDescription(/asked again after a reload/);
	});

	// The contract of this whole screen: an ordinary load starts here, and
	// starting here is not an incident. Anything above the field would read as
	// an apology, and an apology implies something broke.
	it("says nothing else when the page was merely loaded", () => {
		render(<App />);

		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText(/no longer accepts/)).toBeNull();
		expect(screen.queryByText(/no longer accepted/)).toBeNull();
		// Said to a screen reader as well as shown: the notices ride in on the
		// field's description, so silence has to hold there too.
		expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
			/^The --password you started the cluster with\./,
		);
	});

	// The one case that is a real event rather than a fresh start: without a
	// word it would be indistinguishable from an ordinary reload, and the user
	// would conclude their last login never took. Asserted through the
	// description because this screen mounts under the user with the field
	// already focused — a reason not read out with the field is one they never
	// get at all.
	it("explains a session the cluster stopped accepting", () => {
		wsState.reauthReason = "session_expired";

		render(<App />);

		expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
			/no longer accepts this session/,
		);
	});
});

describe("submitting the password", () => {
	it("connects with what was typed", async () => {
		const user = userEvent.setup();
		render(<App />);

		await user.type(screen.getByLabelText("Password"), "hunter2");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(wsState.actions.connect).toHaveBeenCalledWith({
			kind: "password",
			value: "hunter2",
		});
	});

	it("refuses an empty password without connecting", async () => {
		const user = userEvent.setup();
		render(<App />);

		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(screen.getByText("Password is required.")).toBeVisible();
		expect(wsState.actions.connect).not.toHaveBeenCalled();
	});

	// A refusal is nearly always one mistyped character. Clearing the field, or
	// sending the user to a screen of its own, makes them retype all 32.
	it("reports a refusal beside the field and keeps what was typed", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<App />);

		await user.type(screen.getByLabelText("Password"), "huntfr2");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		wsState.status = "auth_failed";
		wsState.errorMessage = "invalid password";
		rerender(<App />);

		expect(screen.getByRole("alert")).toHaveTextContent("invalid password");
		expect(screen.getByLabelText("Password")).toHaveValue("huntfr2");
	});

	// The retry after a refusal has to drive the connection itself: the status
	// is "auth_failed", not "disconnected", so anything waiting for a
	// disconnected store to come round would leave this button doing nothing.
	it("connects again after a refusal", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<App />);

		await user.type(screen.getByLabelText("Password"), "huntfr2");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		wsState.status = "auth_failed";
		rerender(<App />);
		wsState.actions.connect.mockClear();

		await user.clear(screen.getByLabelText("Password"));
		await user.type(screen.getByLabelText("Password"), "hunter2");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(wsState.actions.connect).toHaveBeenCalledWith({
			kind: "password",
			value: "hunter2",
		});
	});
});

describe("password links", () => {
	// A password in a URL is in history, bookmark sync, referrers and access
	// logs before the page can strip it, and it was the one path that skipped
	// the password screen. Old bookmarks must fail out loud, not look broken.
	it("refuses a ?password= link and strips it from the address bar", async () => {
		window.history.replaceState({}, "", "/?password=hunter2");

		render(<App />);

		expect(
			screen.getByText(/Password links are no longer accepted/),
		).toBeVisible();
		expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
			/Password links are no longer accepted/,
		);
		expect(window.location.search).toBe("");
		expect(screen.getByLabelText("Password")).toHaveValue("");
	});

	// The notice answers "why did my link not sign me in". Once a password is
	// typed by hand the user is no longer doing that, and leaving it up would
	// have it stand beside a later refusal explaining the wrong thing.
	it("drops the notice once a password is typed by hand", async () => {
		const user = userEvent.setup();
		window.history.replaceState({}, "", "/?password=hunter2");
		render(<App />);

		await user.type(screen.getByLabelText("Password"), "hunter2");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(
			screen.queryByText(/Password links are no longer accepted/),
		).toBeNull();
	});

	it("refuses the older ?token= spelling too", () => {
		window.history.replaceState({}, "", "/?token=hunter2");

		render(<App />);

		expect(
			screen.getByText(/Password links are no longer accepted/),
		).toBeVisible();
	});
});

describe("connecting", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		wsState.status = "connecting";
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// A local cluster answers well inside the delay. A spinner that appears and
	// vanishes within a few frames reads as a glitch, not as progress.
	it("waits before spinning, but disables the button at once", async () => {
		render(<App />);

		const button = screen.getByRole("button", { name: "Connecting…" });
		expect(button).toBeDisabled();
		expect(screen.queryByRole("status")).toBeNull();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(screen.getByRole("status")).toBeInTheDocument();
	});
});

describe("the unreachable screen", () => {
	beforeEach(() => {
		wsState.status = "reconnecting";
	});

	// Retrying reuses the password held in memory. A cluster restarted under a
	// different one can never accept it, so without this the screen is a loop
	// with no exit.
	it("offers a way back to the password screen", async () => {
		const user = userEvent.setup();
		render(<App />);

		expect(screen.getByText("Cluster unreachable")).toBeVisible();

		// retryNow, not connect: connect sets the status to "connecting", which
		// with no version is the password screen, so a retry would throw the user
		// to another screen and back. The obvious "fix" is to give this button a
		// pending state, which is exactly what brings the flicker with it.
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(wsState.actions.retryNow).toHaveBeenCalled();
		expect(wsState.actions.connect).not.toHaveBeenCalled();

		await user.click(
			screen.getByRole("button", { name: "Use a different password" }),
		);

		expect(wsState.actions.disconnect).toHaveBeenCalled();
	});
});
