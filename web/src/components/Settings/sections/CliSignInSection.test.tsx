import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	resetCliLoginStore,
} from "../../../test/cliAuthFixtures";
import type { CliAuthStatus } from "../../../types/cliAuth";
import CliSignInSection from "./CliSignInSection";

const ws = vi.hoisted(() => ({ actions: {} as Record<string, unknown> }));

vi.mock("../../../lib/wsStore", () => {
	const state = () => ({ status: "connected", actions: ws.actions });
	return {
		useWSStore: Object.assign(
			(selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
			{ getState: state },
		),
	};
});

let server: FakeCliAuth;

beforeEach(() => {
	resetCliLoginStore();
	server = createFakeCliAuth();
	ws.actions = server.actions;
});

/** The card is the list item headed by the CLI's name. */
async function card(name: string) {
	const heading = await screen.findByRole("heading", { name });
	const item = heading.closest("li");
	if (!item) throw new Error(`no card for ${name}`);
	return within(item);
}

function renderWith(
	claude: Omit<CliAuthStatus, "agent">,
	codex?: Omit<CliAuthStatus, "agent">,
) {
	server.setStatuses([
		{ agent: "claude", ...claude },
		{ agent: "codex", ...(codex ?? { state: "signed_out" }) },
	]);
	return render(<CliSignInSection />);
}

describe("CliSignInSection", () => {
	it("shows one card per CLI in engine order, with its version", async () => {
		renderWith(
			{
				state: "signed_in",
				version: "2.1.283",
				account: { email: "ada@example.com", plan: "max" },
			},
			{ state: "signed_out", version: "0.153.0" },
		);

		const claude = await card("Claude");
		expect(
			await claude.findByText("Signed in · ada@example.com · Max"),
		).toBeInTheDocument();
		expect(claude.getByText("2.1.283")).toBeInTheDocument();
		expect(
			claude.getByRole("button", { name: "Sign out" }),
		).toBeInTheDocument();

		const codex = await card("Codex");
		expect(codex.getByText("Not signed in")).toBeInTheDocument();
		expect(codex.getByRole("button", { name: "Sign in" })).toBeInTheDocument();

		const headings = screen.getAllByRole("heading").map((h) => h.textContent);
		expect(headings).toEqual(["Claude", "Codex"]);
	});

	it("says nothing about an account the CLI did not report", async () => {
		renderWith({ state: "signed_in", account: { plan: "unknown" } });
		const claude = await card("Claude");
		expect(await claude.findByText("Signed in")).toBeInTheDocument();
	});

	// Guessing "Not signed in" would send the user into a sign-in that cannot
	// fix what is wrong.
	it("draws an unreadable status as unavailable, with a retry", async () => {
		const user = userEvent.setup();
		renderWith({ state: "unavailable", error: "claude auth status timed out" });

		const claude = await card("Claude");
		expect(
			await claude.findByText("Couldn't read sign-in status"),
		).toBeInTheDocument();
		expect(
			claude.getByText("claude auth status timed out"),
		).toBeInTheDocument();
		expect(claude.queryByText("Not signed in")).not.toBeInTheDocument();

		server.setStatuses([{ agent: "claude", state: "signed_out" }]);
		await user.click(claude.getByRole("button", { name: "Retry" }));
		expect(await claude.findByText("Not signed in")).toBeInTheDocument();
	});

	it("names where external credentials come from, never offering a sign-in", async () => {
		renderWith(
			{
				state: "external",
				external: { kind: "api_key", source: "ANTHROPIC_API_KEY" },
			},
			{ state: "external", external: { kind: "no_sign_in_needed" } },
		);

		const claude = await card("Claude");
		expect(
			await claude.findByText("Managed outside Pockode"),
		).toBeInTheDocument();
		expect(claude.getByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
		expect(claude.queryByRole("button")).not.toBeInTheDocument();

		const codex = await card("Codex");
		expect(
			codex.getByText(
				/doesn't need an OpenAI sign-in\. Change it on the server machine\./,
			),
		).toBeInTheDocument();
	});

	it("points a missing CLI at its install page", async () => {
		renderWith({ state: "not_installed", error: "claude CLI not found" });
		const claude = await card("Claude");
		expect(await claude.findByText("Not installed")).toBeInTheDocument();
		expect(
			claude.getByRole("link", { name: /Install instructions/ }),
		).toHaveAttribute("href", expect.stringContaining("https://"));
	});

	// After a reload the same phone is a new page: what matters is that the
	// flow is running and can be picked up.
	it("offers to continue or cancel a sign-in started earlier", async () => {
		const user = userEvent.setup();
		server.setLatest(makeLogin({ id: "codex-1" }));
		renderWith(
			{ state: "signed_out" },
			{ state: "signing_in", login_id: "codex-1" },
		);

		const codex = await card("Codex");
		expect(await codex.findByText("Signing in…")).toBeInTheDocument();
		expect(codex.getByText("Started earlier.")).toBeInTheDocument();

		server.actions.cliLoginCancel.mockResolvedValue(
			makeLogin({ id: "codex-1", revision: 2, phase: "canceled" }),
		);
		server.setStatuses([{ agent: "codex", state: "signed_out" }]);
		await user.click(codex.getByRole("button", { name: "Cancel" }));

		expect(server.actions.cliLoginCancel).toHaveBeenCalledWith("codex-1");
		expect(await codex.findByText("Not signed in")).toBeInTheDocument();
	});

	it("opens the sign-in sheet from Sign in", async () => {
		const user = userEvent.setup();
		const login = makeLogin({
			id: "codex-1",
			url: "https://auth.openai.com/codex/device",
			user_code: "ABCD-12345",
		});
		// As the server does: once started, status names the running sign-in.
		server.actions.cliLoginStart.mockImplementation(async () => {
			server.setStatuses([
				{ agent: "claude", state: "signed_in" },
				{ agent: "codex", state: "signing_in", login_id: "codex-1" },
			]);
			return login;
		});
		renderWith({ state: "signed_in" });

		const codex = await card("Codex");
		await user.click(await codex.findByRole("button", { name: "Sign in" }));

		expect(
			await screen.findByRole("dialog", { name: "Sign in to Codex" }),
		).toBeInTheDocument();
		expect(await screen.findByText("ABCD-12345")).toBeInTheDocument();
		// The card follows the sign-in the sheet started.
		expect(await codex.findByText("Signing in…")).toBeInTheDocument();
		expect(codex.queryByText("Started earlier.")).not.toBeInTheDocument();

		// Putting the sheet away is not cancelling: the card offers to go on.
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(server.actions.cliLoginCancel).not.toHaveBeenCalled();
		expect(codex.getByText("Signing in…")).toBeInTheDocument();
		expect(codex.getByRole("button", { name: "Continue" })).toBeInTheDocument();
	});

	describe("sign out", () => {
		it("asks first, then shows the status read afterwards", async () => {
			const user = userEvent.setup();
			renderWith({ state: "signed_in", account: { email: "ada@example.com" } });
			server.actions.cliAuthLogout.mockResolvedValue({
				agent: "claude",
				state: "signed_out",
			});

			const claude = await card("Claude");
			await user.click(await claude.findByRole("button", { name: "Sign out" }));
			const dialog = await screen.findByRole("dialog", {
				name: "Sign out of Claude?",
			});
			expect(dialog).toHaveTextContent("cluster nodes on this machine");
			await user.click(
				within(dialog).getByRole("button", { name: "Sign out" }),
			);

			expect(server.actions.cliAuthLogout).toHaveBeenCalledWith("claude");
			expect(await claude.findByText("Not signed in")).toBeInTheDocument();
		});

		it("does nothing when the confirm is cancelled", async () => {
			const user = userEvent.setup();
			renderWith({ state: "signed_in" });

			const claude = await card("Claude");
			await user.click(await claude.findByRole("button", { name: "Sign out" }));
			const dialog = await screen.findByRole("dialog");
			await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

			expect(server.actions.cliAuthLogout).not.toHaveBeenCalled();
		});

		it("keeps the signed-in state and shows why a sign-out failed", async () => {
			const user = userEvent.setup();
			renderWith({ state: "signed_in" });
			server.actions.cliAuthLogout.mockRejectedValue(
				new Error("claude auth logout failed: Logout failed: EACCES"),
			);

			const claude = await card("Claude");
			await user.click(await claude.findByRole("button", { name: "Sign out" }));
			await user.click(
				within(await screen.findByRole("dialog")).getByRole("button", {
					name: "Sign out",
				}),
			);

			expect(await claude.findByRole("alert")).toHaveTextContent(
				"claude auth logout failed: Logout failed: EACCES",
			);
			expect(claude.getByText("Signed in")).toBeInTheDocument();
		});
	});

	it("reads status again when the page comes back into view", async () => {
		renderWith({ state: "signed_out" });
		const claude = await card("Claude");
		expect(await claude.findByText("Not signed in")).toBeInTheDocument();

		server.setStatuses([
			{ agent: "claude", state: "signed_in" },
			{ agent: "codex", state: "signed_out" },
		]);
		document.dispatchEvent(new Event("visibilitychange"));

		expect(await claude.findByText("Signed in")).toBeInTheDocument();
	});
});
