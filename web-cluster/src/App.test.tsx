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
const authState = { token: null as string | null };

vi.mock("./lib/wsStore", () => ({ useWSStore: () => wsState }));
vi.mock("./lib/authStore", () => ({
	useAuthStore: (selector: (s: typeof authState) => unknown) =>
		selector(authState),
	authActions: { login: vi.fn(), logout: vi.fn() },
}));

afterEach(() => {
	wsState.status = "disconnected";
	authState.token = null;
	vi.clearAllMocks();
});

describe("the token screen", () => {
	// A cluster token is long and random and usually typed on a phone keyboard.
	// Typing it blind is the single worst moment in this product, and a wrong
	// character is only discoverable by being turned away.
	it("lets the token be read back", async () => {
		const user = userEvent.setup();
		render(<App />);

		const field = screen.getByLabelText("Auth Token");
		expect(field).toHaveAttribute("type", "password");

		await user.click(screen.getByRole("button", { name: "Show" }));
		expect(field).toHaveAttribute("type", "text");

		await user.click(screen.getByRole("button", { name: "Hide" }));
		expect(field).toHaveAttribute("type", "password");
	});

	// Asserted through the field's accessible description rather than as loose
	// text on the page: the answer is only useful to someone who is being asked
	// the question, and the wiring that delivers it is the part that rots.
	it("says where the token comes from", () => {
		render(<App />);

		expect(screen.getByLabelText("Auth Token")).toHaveAccessibleDescription(
			/--auth-token/,
		);
	});
});

describe("connecting", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		authState.token = "cluster-token";
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
