import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const wsState = {
	status: "disconnected",
	errorMessage: null as string | null,
	version: null as string | null,
	actions: { connect: vi.fn(), disconnect: vi.fn(), listNodes: vi.fn() },
};
const authState = {
	sessionToken: null as string | null,
	password: null as string | null,
};

vi.mock("./lib/wsStore", () => ({ useWSStore: () => wsState }));
vi.mock("./lib/authStore", () => ({
	useAuthStore: (selector: (s: typeof authState) => unknown) =>
		selector(authState),
	selectCredential: (s: typeof authState) =>
		s.sessionToken
			? { kind: "session_token", value: s.sessionToken }
			: s.password
				? { kind: "password", value: s.password }
				: null,
	authActions: { login: vi.fn(), logout: vi.fn() },
}));

afterEach(() => {
	wsState.status = "disconnected";
	authState.sessionToken = null;
	authState.password = null;
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

		await user.click(screen.getByRole("button", { name: "Show" }));
		expect(field).toHaveAttribute("type", "text");

		await user.click(screen.getByRole("button", { name: "Hide" }));
		expect(field).toHaveAttribute("type", "password");
	});

	// Asserted through the field's accessible description rather than as loose
	// text on the page: the answer is only useful to someone who is being asked
	// the question, and the wiring that delivers it is the part that rots.
	it("says where the password comes from", () => {
		render(<App />);

		expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
			/--password/,
		);
	});

	// The password the user types is the one thing that must never outlive the
	// tab: it is exchanged for a session token and dropped. The screen is
	// reached on the strength of there being no credential at all, so a stored
	// token — and only a stored token — is what skips it.
	it("is skipped once a session token is held", () => {
		authState.sessionToken = "stored-session";
		wsState.status = "connected";

		render(<App />);

		expect(screen.queryByLabelText("Password")).toBeNull();
	});
});

describe("connecting", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		authState.sessionToken = "cluster-session-token";
		wsState.status = "connecting";
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// A local cluster answers well inside the delay. A spinner that appears and
	// vanishes within a few frames reads as a glitch, not as progress.
	it("says nothing about a connect that is about to succeed", async () => {
		render(<App />);

		expect(screen.queryByText("Connecting to cluster...")).toBeNull();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(screen.getByText("Connecting to cluster...")).toBeInTheDocument();
	});
});
