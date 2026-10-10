import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	makeUpdate,
	resetCliLoginStore,
} from "../../../test/cliAuthFixtures";
import type { CliAuthStatus } from "../../../types/cliAuth";
import type { CliUpdate, CliUpdateCheck } from "../../../types/cliUpdate";
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

/**
 * Finds a row by its title and checks the line under it: every row is the two
 * lines, whatever its state.
 */
async function findRow(
	scope: Awaited<ReturnType<typeof card>>,
	title: string,
	subtitle: string,
) {
	const line = await scope.findByText(title, { selector: "p" });
	expect(line.nextElementSibling).toHaveTextContent(subtitle);
	return line;
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
	it("shows one card per CLI in engine order", async () => {
		renderWith(
			{
				state: "signed_in",
				version: "2.1.283",
				account: { email: "ada@example.com", plan: "max" },
			},
			{ state: "signed_out", version: "0.153.0" },
		);

		const claude = await card("Claude");
		await findRow(claude, "Signed in", "ada@example.com · Max");
		expect(
			claude.getByRole("button", { name: "Sign out" }),
		).toBeInTheDocument();

		const codex = await card("Codex");
		await findRow(codex, "Not signed in", "Sign in to use Codex");
		expect(codex.getByRole("button", { name: "Sign in" })).toBeInTheDocument();

		const headings = screen.getAllByRole("heading").map((h) => h.textContent);
		expect(headings).toEqual(["Claude", "Codex"]);
	});

	// The rows are there from the first paint, holding the place of the values
	// they wait for, so nothing moves when the answers land.
	it("draws both rows of every card while nothing has been read", async () => {
		server.actions.cliAuthStatus.mockReturnValue(new Promise(() => {}));
		server.actions.cliUpdateCheck.mockReturnValue(new Promise(() => {}));
		render(<CliSignInSection />);

		for (const name of ["Claude", "Codex"]) {
			const scope = await card(name);
			expect(
				scope.getByRole("status", { name: `Checking ${name} version` }),
			).toBeInTheDocument();
			expect(
				scope.getByRole("status", {
					name: `Checking ${name} sign-in status`,
				}),
			).toBeInTheDocument();
			expect(scope.queryByRole("button")).not.toBeInTheDocument();
		}
	});

	it("says nothing about an account the CLI did not report", async () => {
		renderWith({ state: "signed_in", account: { plan: "unknown" } });
		const claude = await card("Claude");
		expect(await claude.findByText("Signed in")).toBeInTheDocument();
		expect(claude.queryByText(/unknown/i)).not.toBeInTheDocument();
	});

	// Guessing "Not signed in" would send the user into a sign-in that cannot
	// fix what is wrong.
	it("draws an unreadable status as unavailable, with a retry", async () => {
		const user = userEvent.setup();
		renderWith({ state: "unavailable", error: "claude auth status timed out" });

		const claude = await card("Claude");
		await findRow(claude, "Couldn't read sign-in status", "Retry, or refresh");
		// The reason is on the screen, not behind a hover.
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
		await findRow(claude, "Managed outside Pockode", "ANTHROPIC_API_KEY");
		expect(
			claude.getByText(/from the server's environment\. Change it/),
		).toBeInTheDocument();
		expect(
			claude.queryByRole("button", { name: /Sign in|Sign out/ }),
		).not.toBeInTheDocument();

		const codex = await card("Codex");
		expect(
			codex.getByText(
				/doesn't need an OpenAI sign-in\. Change it on the server machine\./,
			),
		).toBeInTheDocument();
	});

	it("offers to install a missing CLI, with sign-in waiting for it", async () => {
		renderWith({ state: "not_installed", error: "claude CLI not found" });
		const claude = await card("Claude");
		await findRow(claude, "Not installed", "Installs with npm");
		expect(claude.getByRole("button", { name: "Install" })).toBeInTheDocument();
		await findRow(claude, "Sign-in", "Available once Claude is installed");
		expect(
			claude.queryByRole("button", { name: "Sign in" }),
		).not.toBeInTheDocument();
	});

	// After a reload the same phone is a new page: what matters is that the
	// flow is running and can be picked up.
	it("offers to continue a sign-in started earlier, and cancel it from the sheet", async () => {
		const user = userEvent.setup();
		server.setLatest(makeLogin({ id: "codex-1" }));
		renderWith(
			{ state: "signed_out" },
			{ state: "signing_in", login_id: "codex-1" },
		);

		const codex = await card("Codex");
		await findRow(codex, "Signing in…", "Started earlier.");
		// Two buttons don't fit beside the line on a phone: Cancel is the sheet's.
		expect(
			codex.queryByRole("button", { name: "Cancel" }),
		).not.toBeInTheDocument();

		server.actions.cliLoginCancel.mockResolvedValue(
			makeLogin({ id: "codex-1", revision: 2, phase: "canceled" }),
		);
		server.setStatuses([{ agent: "codex", state: "signed_out" }]);
		await user.click(codex.getByRole("button", { name: "Continue" }));
		const sheet = await screen.findByRole("dialog", {
			name: "Sign in to Codex",
		});
		await user.click(within(sheet).getByRole("button", { name: "Cancel" }));

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

	describe("versions and updates", () => {
		function claudeCheck(check: Partial<CliUpdateCheck> = {}): CliUpdateCheck {
			return {
				agent: "claude",
				state: "update_available",
				version: "2.1.283",
				latest_version: "2.1.290",
				channel: "latest",
				running_sessions: 0,
				...check,
			};
		}

		function renderChecked(
			check: Partial<CliUpdateCheck> = {},
			status: Omit<CliAuthStatus, "agent"> = { state: "signed_in" },
		) {
			server.setChecks([
				claudeCheck(check),
				{
					agent: "codex",
					state: "up_to_date",
					version: "0.153.0",
					latest_version: "0.153.0",
					channel: "latest",
					running_sessions: 0,
				},
			]);
			return renderWith(status);
		}

		it.each([
			[{ state: "up_to_date" as const }, "Up to date"],
			[{}, "2.1.290 available"],
			[{ channel: "stable" }, "2.1.290 on stable"],
		])("draws a check of %o", async (check, state) => {
			renderChecked(check);
			const claude = await card("Claude");
			await findRow(claude, "Version 2.1.283", state);
		});

		// "Couldn't check" is never folded into the benign "Up to date".
		it("says it couldn't check when the latest version couldn't be read", async () => {
			renderChecked({
				state: "unavailable",
				latest_version: undefined,
				error: "registry.npmjs.org: no such host",
			});
			const claude = await card("Claude");
			await findRow(claude, "Version 2.1.283", "Couldn't check for updates");
			expect(
				claude.getByText("registry.npmjs.org: no such host"),
			).toBeInTheDocument();
			expect(claude.queryByText(/Up to date/)).not.toBeInTheDocument();
			expect(
				claude.queryByRole("button", { name: "Update" }),
			).not.toBeInTheDocument();
		});

		it("says it couldn't check when the check request failed", async () => {
			server.actions.cliUpdateCheck.mockRejectedValue(
				new Error("Request timed out"),
			);
			renderWith({ state: "signed_in", version: "2.1.283" });
			const claude = await card("Claude");
			await findRow(claude, "Version 2.1.283", "Couldn't check for updates");
			expect(claude.getByText("Request timed out")).toBeInTheDocument();
		});

		it.each([
			[
				"an unreadable version",
				{ state: "unavailable" as const, version: undefined, error: "exit 1" },
				"Couldn't read the version",
				"Version unknown",
			],
			[
				"a release this install hasn't got",
				{ state: "not_yet_available" as const },
				"Version 2.1.283",
				"2.1.290 is out · not reachable yet",
			],
		])("offers no update for %s", async (_, check, title, subtitle) => {
			renderChecked(check);
			const claude = await card("Claude");
			await findRow(claude, title, subtitle);
			expect(
				claude.queryByRole("button", { name: "Update" }),
			).not.toBeInTheDocument();
		});

		it("draws no version for a CLI that isn't installed", async () => {
			renderChecked(
				{
					state: "not_installed",
					version: undefined,
					latest_version: undefined,
				},
				{ state: "not_installed" },
			);
			const claude = await card("Claude");
			expect(await claude.findByText("Not installed")).toBeInTheDocument();
			expect(claude.queryByText(/Version|Checking/)).not.toBeInTheDocument();
		});

		it("confirms, naming running sessions, then shows the update running", async () => {
			const user = userEvent.setup();
			renderChecked();
			server.actions.cliUpdateStart.mockResolvedValue(makeUpdate());

			const claude = await card("Claude");
			const update = await claude.findByRole("button", { name: "Update" });
			// Sessions opened since the card was drawn: the dialog reads the check
			// again as it opens.
			server.setChecks([claudeCheck({ running_sessions: 2 })]);
			await user.click(update);
			const dialog = await screen.findByRole("dialog", {
				name: "Update Claude?",
			});
			expect(dialog).toHaveTextContent(
				"2.1.290 is available; this server has 2.1.283.",
			);
			expect(dialog).toHaveTextContent("cluster node");
			await vi.waitFor(() =>
				expect(dialog).toHaveTextContent(
					"Claude is open in 2 sessions in this project. They aren't interrupted — they keep 2.1.283",
				),
			);
			expect(server.actions.cliUpdateStart).not.toHaveBeenCalled();
			await user.click(within(dialog).getByRole("button", { name: "Update" }));

			expect(server.actions.cliUpdateStart).toHaveBeenCalledWith("claude");
			expect(
				await claude.findByText("Updating Claude…", { selector: "p" }),
			).toBeInTheDocument();
			expect(claude.getByText(/^Started \d+:\d\d ago$/)).toBeInTheDocument();
		});

		it("closes the dialog when the check it re-reads finds an update running", async () => {
			const user = userEvent.setup();
			renderChecked();

			const claude = await card("Claude");
			const update = await claude.findByRole("button", { name: "Update" });
			server.setChecks([
				claudeCheck({ state: "updating", update_id: "update-1" }),
			]);
			await user.click(update);

			expect(
				await claude.findByText("Updating Claude…", { selector: "p" }),
			).toBeInTheDocument();
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(server.actions.cliUpdateStart).not.toHaveBeenCalled();
		});

		it("shows a refused start in the server's words under the row", async () => {
			const user = userEvent.setup();
			renderChecked();
			server.actions.cliUpdateStart.mockRejectedValue(
				new Error("claude is being updated by another Pockode on this machine"),
			);

			const claude = await card("Claude");
			await user.click(await claude.findByRole("button", { name: "Update" }));
			await user.click(
				within(await screen.findByRole("dialog")).getByRole("button", {
					name: "Update",
				}),
			);

			expect(await claude.findByRole("alert")).toHaveTextContent(
				"claude is being updated by another Pockode on this machine",
			);

			// Gone once the check has moved on; the dialog's own re-read, which
			// answered the same, did not take it away.
			server.setChecks([claudeCheck({ state: "up_to_date" })]);
			await user.click(screen.getByRole("button", { name: "Refresh" }));
			await findRow(claude, "Version 2.1.283", "Up to date");
			expect(claude.queryByRole("alert")).not.toBeInTheDocument();
		});

		// The update belongs to the server: a page that did not start it still
		// shows it, and nothing that would run the CLI is offered meanwhile.
		it("holds the sign-in still while an update started elsewhere runs", async () => {
			server.setLatestUpdate("claude", makeUpdate());
			renderChecked(
				{ state: "updating", update_id: "update-1", version: undefined },
				{ state: "signed_in", account: { email: "ada@example.com" } },
			);

			const claude = await card("Claude");
			expect(
				await claude.findByText("Updating Claude…", { selector: "p" }),
			).toBeInTheDocument();
			expect(claude.getByText("Started earlier.")).toBeInTheDocument();
			await findRow(claude, "Signed in", "Wait for the update to finish.");
			expect(
				claude.queryByRole("button", { name: "Sign out" }),
			).not.toBeInTheDocument();

			const codex = await card("Codex");
			expect(
				codex.getByRole("button", { name: "Sign in" }),
			).toBeInTheDocument();
		});

		it("says sign-in is read afterwards when there is no earlier read to keep", async () => {
			server.setLatestUpdate("claude", makeUpdate());
			renderChecked(
				{ state: "updating", update_id: "update-1", version: undefined },
				{ state: "updating", update_id: "update-1" },
			);

			const claude = await card("Claude");
			await findRow(claude, "Sign-in", "Checked after the update.");
			expect(claude.queryByRole("button")).not.toBeInTheDocument();
		});

		it("holds Update off while a sign-in to the CLI runs", async () => {
			server.setLatest(makeLogin({ id: "claude-1", agent: "claude" }));
			renderChecked({}, { state: "signing_in", login_id: "claude-1" });

			const claude = await card("Claude");
			await findRow(
				claude,
				"Version 2.1.283",
				"2.1.290 · update after sign-in",
			);
			expect(
				claude.queryByRole("button", { name: "Update" }),
			).not.toBeInTheDocument();
		});

		it("confirms an update it watched end, and re-reads the version", async () => {
			server.setLatestUpdate("claude", makeUpdate());
			renderChecked({
				state: "updating",
				update_id: "update-1",
				version: undefined,
			});
			const claude = await card("Claude");
			expect(
				await claude.findByText("Updating Claude…", { selector: "p" }),
			).toBeInTheDocument();
			// One region that stays mounted, so each phase is heard as it arrives.
			const status = claude.getByRole("status");
			expect(status).toHaveTextContent("Updating Claude…");

			server.setChecks([
				claudeCheck({ state: "up_to_date", version: "2.1.290" }),
			]);
			server.pushUpdate(
				"claude",
				makeUpdate({ revision: 2, phase: "succeeded", to_version: "2.1.290" }),
			);

			await findRow(claude, "Updated to 2.1.290", "from 2.1.283");
			expect(claude.getByRole("status")).toBe(status);
			expect(status).toHaveTextContent("Updated from 2.1.283 to 2.1.290");
			await vi.waitFor(() =>
				expect(server.actions.cliUpdateCheck).toHaveBeenLastCalledWith(
					"claude",
				),
			);
		});

		it("says so when an update found nothing newer to install", async () => {
			server.setLatestUpdate("claude", makeUpdate());
			renderChecked({
				state: "updating",
				update_id: "update-1",
				version: undefined,
			});
			const claude = await card("Claude");
			expect(
				await claude.findByText("Updating Claude…", { selector: "p" }),
			).toBeInTheDocument();

			server.setChecks([claudeCheck({ state: "up_to_date" })]);
			server.pushUpdate(
				"claude",
				makeUpdate({ revision: 2, phase: "succeeded", to_version: "2.1.283" }),
			);
			await findRow(claude, "Already up to date", "Version 2.1.283");
			expect(claude.getByRole("status")).toHaveTextContent(
				"Claude was already up to date (2.1.283)",
			);
		});

		// "Updated" is the confirmation on the screen that watched; it goes when
		// the user leaves Settings, and a return draws the check.
		it("forgets an update it confirmed once the user leaves Settings", async () => {
			server.setLatestUpdate("claude", makeUpdate());
			const { unmount } = renderChecked({
				state: "updating",
				update_id: "update-1",
				version: undefined,
			});
			const claude = await card("Claude");
			expect(
				await claude.findByText("Updating Claude…", { selector: "p" }),
			).toBeInTheDocument();
			server.setChecks([
				claudeCheck({ state: "up_to_date", version: "2.1.290" }),
			]);
			server.pushUpdate(
				"claude",
				makeUpdate({ revision: 2, phase: "succeeded", to_version: "2.1.290" }),
			);
			await findRow(claude, "Updated to 2.1.290", "from 2.1.283");

			unmount();
			render(<CliSignInSection />);
			const again = await card("Claude");
			await findRow(again, "Version 2.1.290", "Up to date");
			expect(again.queryByText(/Updated/)).not.toBeInTheDocument();
		});

		// The update runs on the server; a page that left and came back, or
		// reconnected, finds it where it is now.
		it("resumes a running update after the page comes back", async () => {
			server.setLatestUpdate("claude", makeUpdate());
			const { unmount } = renderChecked({
				state: "updating",
				update_id: "update-1",
				version: undefined,
			});
			expect(
				await (await card("Claude")).findByText("Updating Claude…", {
					selector: "p",
				}),
			).toBeInTheDocument();
			unmount();

			server.setLatestUpdate(
				"claude",
				makeUpdate({
					revision: 2,
					phase: "failed",
					to_version: "2.1.283",
					failure: { reason: "timeout" },
				}),
			);
			server.setChecks([claudeCheck()]);
			render(<CliSignInSection />);
			expect(
				await (await card("Claude")).findByText("The update took too long", {
					selector: "p",
				}),
			).toBeInTheDocument();
		});

		it("draws the version as checking until the check answers", async () => {
			server.actions.cliUpdateCheck.mockReturnValue(new Promise(() => {}));
			renderWith({ state: "signed_in", version: "2.1.283" });
			const claude = await card("Claude");
			await findRow(claude, "Version 2.1.283", "Checking for updates…");
		});

		it("leaves a success that ended before the page came to the screen that saw it", async () => {
			server.setLatestUpdate(
				"claude",
				makeUpdate({ phase: "succeeded", to_version: "2.1.290" }),
			);
			renderChecked({ state: "up_to_date", version: "2.1.290" });

			const claude = await card("Claude");
			await findRow(claude, "Version 2.1.290", "Up to date");
			expect(claude.queryByText(/Updated/)).not.toBeInTheDocument();
		});

		describe("a failed update", () => {
			it("stays up until dismissed, for every client", async () => {
				const user = userEvent.setup();
				server.setLatestUpdate(
					"claude",
					makeUpdate({
						phase: "failed",
						failure: { reason: "other", detail: "the server is shutting down" },
					}),
				);
				renderChecked();

				const claude = await card("Claude");
				expect(
					await claude.findByText("Update failed", { selector: "p" }),
				).toBeInTheDocument();
				expect(
					claude.getByText("the server is shutting down"),
				).toBeInTheDocument();
				// The version is the CLI's as the check reads it now.
				expect(claude.getByText("Version 2.1.283")).toBeInTheDocument();

				await user.click(claude.getByRole("button", { name: "Dismiss" }));
				expect(server.actions.cliUpdateDismiss).toHaveBeenCalledWith(
					"update-1",
				);
				await findRow(claude, "Version 2.1.283", "2.1.290 available");
			});

			// Someone changed the CLI since: the failure is about a version gone.
			it("is not shown once the installed version has moved from where the update left it", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({ phase: "failed", failure: { reason: "timeout" } }),
				);
				renderChecked({ state: "up_to_date", version: "2.1.290" });

				const claude = await card("Claude");
				await findRow(claude, "Version 2.1.290", "Up to date");
				expect(
					claude.queryByText("The update took too long"),
				).not.toBeInTheDocument();
			});

			// A failure can move the CLI part of the way; that is still news.
			it("stays up when the update moved the version short of its target", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({
						phase: "failed",
						to_version: "2.1.285",
						failure: { reason: "not_applied" },
					}),
				);
				renderChecked({ version: "2.1.285" });

				const claude = await card("Claude");
				expect(
					await claude.findByText(
						"Claude was still at 2.1.285 after updating",
						{ selector: "p" },
					),
				).toBeInTheDocument();
				// The card's version is the check's, never the record's `from`.
				expect(claude.getByText("Version 2.1.285")).toBeInTheDocument();
				expect(claude.queryByText(/2\.1\.283/)).not.toBeInTheDocument();
			});

			it("is kept when a version to compare is missing", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({
						phase: "failed",
						from_version: undefined,
						failure: { reason: "timeout" },
					}),
				);
				renderChecked({ version: "2.1.290" });

				expect(
					await (await card("Claude")).findByText("The update took too long", {
						selector: "p",
					}),
				).toBeInTheDocument();
			});

			it("offers to install a CLI that went missing", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({ phase: "failed", failure: { reason: "not_installed" } }),
				);
				renderChecked(
					{ state: "not_installed", version: undefined },
					{ state: "not_installed" },
				);

				const claude = await card("Claude");
				expect(
					await claude.findByText("Claude wasn't found", { selector: "p" }),
				).toBeInTheDocument();
				await userEvent
					.setup()
					.click(claude.getByRole("button", { name: "Install" }));
				expect(
					await screen.findByRole("dialog", { name: "Install Claude?" }),
				).toBeInTheDocument();
				expect(
					claude.getByRole("button", { name: "Dismiss" }),
				).toBeInTheDocument();
			});

			// The check and status held from before the update still say it is there.
			it("treats the CLI as missing before it is read again", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({ phase: "failed", failure: { reason: "not_installed" } }),
				);
				renderChecked({}, { state: "signed_out" });

				const claude = await card("Claude");
				await findRow(claude, "Sign-in", "Available once Claude is installed");
				expect(
					claude.queryByRole("button", { name: "Sign in" }),
				).not.toBeInTheDocument();
				await userEvent
					.setup()
					.click(claude.getByRole("button", { name: "Install" }));
				expect(
					await screen.findByRole("dialog", { name: "Install Claude?" }),
				).toBeInTheDocument();
			});

			it("confirms Try again before starting another update", async () => {
				const user = userEvent.setup();
				server.setLatestUpdate(
					"claude",
					makeUpdate({ phase: "failed", failure: { reason: "timeout" } }),
				);
				renderChecked();

				const claude = await card("Claude");
				await user.click(
					await claude.findByRole("button", { name: "Try again" }),
				);
				expect(
					await screen.findByRole("dialog", { name: "Update Claude?" }),
				).toBeInTheDocument();
				expect(server.actions.cliUpdateStart).not.toHaveBeenCalled();
			});

			it.each([
				{
					// npm's own EACCES block, as the server's tail keeps it.
					reason: "command_failed" as const,
					detail: [
						"npm error   path: '/usr/lib/node_modules'",
						"npm error }",
						"npm error",
						"npm error The operation was rejected by your operating system.",
						"npm error It is likely you do not have the permissions to access this file as the current user",
						"npm error",
						"npm error If you believe this might be a permissions issue, please double-check the",
						"npm error permissions of the file and its containing directories, or try running",
						"npm error the command again as root/Administrator.",
						"npm error A complete log of this run can be found in: /home/ada/.npm/_logs/debug.log",
					].join("\n"),
					title: "Claude couldn't update itself",
					body: "npm error It is likely you do not have the permissions to access this file as the current user Fix it on the server, or run claude update there.",
					tryAgain: true,
				},
				{
					// Claude 2.1.283's own output when the registry cannot be read.
					reason: "command_failed" as const,
					detail:
						"Failed to check for updates\nUnable to fetch latest version from npm registry\nPossible causes:\n  • Network connectivity issues\nTry:\n  • Check if you need to login: npm whoami",
					title: "Claude couldn't update itself",
					body: "Unable to fetch latest version from npm registry Fix it on the server",
					tryAgain: true,
				},
				{
					reason: "not_applied" as const,
					to_version: "2.1.283",
					title: "Claude was still at 2.1.283 after updating",
					body: "The update didn't reach the claude Pockode runs (/home/ada/.local/bin/claude). Either the way it is installed doesn't have 2.1.290 yet",
					tryAgain: false,
				},
				{
					reason: "timeout" as const,
					title: "The update took too long",
					body: "If Claude no longer starts, run claude update on the server.",
					tryAgain: true,
				},
				{
					reason: "not_installed" as const,
					title: "Claude wasn't found",
					body: "Pockode can't find the claude command.",
					tryAgain: false,
				},
			])("explains $reason", async ({
				reason,
				detail,
				to_version,
				title,
				body,
				tryAgain,
			}) => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({
						phase: "failed",
						to_version,
						failure: { reason, detail },
					}),
				);
				renderChecked();

				const claude = await card("Claude");
				const heading = await claude.findByText(title, { selector: "p" });
				const item = heading.closest("li");
				if (!item) throw new Error("no card");
				expect(item).toHaveTextContent(body);
				expect(
					claude.queryByRole("button", { name: "Try again" }) !== null,
				).toBe(tryAgain);
			});

			it("shows where the CLI said why, and opens it for not applied", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({
						phase: "failed",
						to_version: "2.1.283",
						failure: {
							reason: "not_applied",
							detail: "Successfully updated to 2.1.290",
						},
					}),
				);
				renderChecked();

				const claude = await card("Claude");
				expect(
					await claude.findByRole("button", { name: "Details" }),
				).toHaveAttribute("aria-expanded", "true");
				expect(
					claude.getByText("Successfully updated to 2.1.290"),
				).toBeVisible();
			});
		});
	});

	describe("installing a missing CLI", () => {
		const missing: CliUpdateCheck = {
			agent: "claude",
			state: "not_installed",
			channel: "latest",
			running_sessions: 0,
		};
		const installed: CliUpdateCheck = {
			...missing,
			state: "up_to_date",
			version: "2.1.290",
			latest_version: "2.1.290",
		};

		function makeInstall(overrides: Partial<CliUpdate> = {}): CliUpdate {
			return makeUpdate({
				kind: "install",
				from_version: undefined,
				binary_path: undefined,
				...overrides,
			});
		}

		function renderMissing() {
			server.setChecks([missing]);
			return renderWith({ state: "not_installed" });
		}

		async function confirmInstall() {
			const user = userEvent.setup();
			const claude = await card("Claude");
			await user.click(await claude.findByRole("button", { name: "Install" }));
			const dialog = await screen.findByRole("dialog", {
				name: "Install Claude?",
			});
			await user.click(within(dialog).getByRole("button", { name: "Install" }));
			return claude;
		}

		function refusal(reason: string, message: string) {
			return new JSONRPCErrorException(message, -32003, { reason });
		}

		it("confirms, shows the install running, then the CLI ready to sign in to", async () => {
			const user = userEvent.setup();
			renderMissing();
			// Past two minutes: npm's silence no longer looks like progress.
			server.actions.cliUpdateInstall.mockResolvedValue(
				makeInstall({
					started_at: new Date(Date.now() - 130_000).toISOString(),
				}),
			);

			const claude = await card("Claude");
			await user.click(await claude.findByRole("button", { name: "Install" }));
			const dialog = await screen.findByRole("dialog", {
				name: "Install Claude?",
			});
			expect(dialog).toHaveTextContent(
				"npm install --global for the latest Claude (latest channel)",
			);
			expect(dialog).toHaveTextContent("every project and cluster node");
			expect(server.actions.cliUpdateInstall).not.toHaveBeenCalled();
			await user.click(within(dialog).getByRole("button", { name: "Install" }));

			expect(server.actions.cliUpdateInstall).toHaveBeenCalledWith("claude");
			await findRow(claude, "Installing Claude 2.1.290…", "· up to 10 min");
			const status = claude.getByRole("status");
			expect(status).toHaveTextContent("Installing Claude 2.1.290…");
			await findRow(claude, "Sign-in", "Available once Claude is installed");
			expect(claude.queryByRole("button")).not.toBeInTheDocument();

			// The reads the ending sets off are held, to see the card between.
			let answerCheck = () => {};
			let answerStatus = () => {};
			server.actions.cliUpdateCheck.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						answerCheck = () => resolve([installed]);
					}),
			);
			server.actions.cliAuthStatus.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						answerStatus = () =>
							resolve([
								{ agent: "claude", state: "signed_out", version: "2.1.290" },
							]);
					}),
			);
			server.pushUpdate(
				"claude",
				makeInstall({
					revision: 2,
					phase: "succeeded",
					to_version: "2.1.290",
				}),
			);

			await findRow(
				claude,
				"Installed Claude 2.1.290",
				"Checking for updates…",
			);
			expect(status).toHaveTextContent("Installed Claude 2.1.290");
			expect(
				claude.getByRole("status", { name: "Checking Claude sign-in status" }),
			).toBeInTheDocument();

			act(() => {
				answerCheck();
				answerStatus();
			});
			await findRow(
				claude,
				"Installed Claude 2.1.290",
				"Version 2.1.290 · Up to date",
			);
			await findRow(claude, "Not signed in", "Sign in to use Claude");
			expect(claude.getByRole("button", { name: "Sign in" })).toBeEnabled();
		});

		it("shows an install started elsewhere, with sign-in waiting for it", async () => {
			server.setLatestUpdate(
				"claude",
				makeInstall({ target_version: undefined }),
			);
			server.setChecks([
				{ ...missing, state: "installing", update_id: "update-1" },
			]);
			renderWith({ state: "updating", update_id: "update-1" });

			const claude = await card("Claude");
			await findRow(claude, "Installing Claude…", "Started earlier.");
			await findRow(claude, "Sign-in", "Available once Claude is installed");
			expect(claude.queryByRole("button")).not.toBeInTheDocument();
		});

		// Coming back to the page mid-install reads `installing` and `updating`
		// for it; once it has ended, those reads are history.
		describe("after reads taken while it ran", () => {
			function renderRunning() {
				server.setLatestUpdate("claude", makeInstall());
				server.setChecks([
					{ ...missing, state: "installing", update_id: "update-1" },
				]);
				return renderWith({ state: "updating", update_id: "update-1" });
			}

			function holdCheck() {
				server.actions.cliUpdateCheck.mockImplementation(
					() => new Promise(() => {}),
				);
			}

			it("shows the sign-in as soon as it is read, without waiting for the check", async () => {
				renderRunning();
				const claude = await card("Claude");
				await findRow(claude, "Installing Claude 2.1.290…", "Started earlier.");

				holdCheck();
				server.setStatuses([{ agent: "claude", state: "signed_out" }]);
				server.pushUpdate(
					"claude",
					makeInstall({
						revision: 2,
						phase: "succeeded",
						to_version: "2.1.290",
					}),
				);

				await findRow(claude, "Not signed in", "Sign in to use Claude");
				await findRow(
					claude,
					"Installed Claude 2.1.290",
					"Checking for updates…",
				);
			});

			it("lets Try again open the dialog", async () => {
				const user = userEvent.setup();
				renderRunning();
				const claude = await card("Claude");
				await findRow(claude, "Installing Claude 2.1.290…", "Started earlier.");

				holdCheck();
				server.actions.cliAuthStatus.mockImplementation(
					() => new Promise(() => {}),
				);
				server.pushUpdate(
					"claude",
					makeInstall({
						revision: 2,
						phase: "failed",
						failure: { reason: "timeout" },
					}),
				);

				await user.click(
					await claude.findByRole("button", { name: "Try again" }),
				);
				expect(
					await screen.findByRole("dialog", { name: "Install Claude?" }),
				).toBeInTheDocument();
			});
		});

		it("says so when the check after an install fails", async () => {
			server.setLatestUpdate("claude", makeInstall());
			renderMissing();
			const claude = await card("Claude");
			await findRow(claude, "Installing Claude 2.1.290…", "Started earlier.");

			server.actions.cliUpdateCheck.mockRejectedValue(
				new Error("connection lost"),
			);
			server.pushUpdate(
				"claude",
				makeInstall({ revision: 2, phase: "succeeded", to_version: "2.1.290" }),
			);

			await findRow(
				claude,
				"Installed Claude 2.1.290",
				"Couldn't check for updates",
			);
			expect(claude.getByText(/connection lost/)).toBeInTheDocument();
		});

		describe("refused", () => {
			it("says npm is missing, pointing at the other ways", async () => {
				renderMissing();
				server.actions.cliUpdateInstall.mockRejectedValue(
					refusal(
						"npm_not_found",
						"npm was not found on the server's PATH; install Node.js and restart pockode",
					),
				);
				const claude = await confirmInstall();

				expect(await claude.findByRole("alert")).toHaveTextContent(
					"npm was not found on the server's PATH",
				);
				expect(
					claude.getByRole("link", { name: /Install instructions/ }),
				).toBeInTheDocument();
				expect(claude.getByRole("button", { name: "Install" })).toBeEnabled();
			});

			it("says the CLI is busy, without pointing elsewhere", async () => {
				renderMissing();
				server.actions.cliUpdateInstall.mockRejectedValue(
					refusal("busy", "claude is being installed by another Pockode"),
				);
				const claude = await confirmInstall();

				expect(await claude.findByRole("alert")).toHaveTextContent(
					"claude is being installed by another Pockode",
				);
				expect(claude.queryByRole("link")).not.toBeInTheDocument();

				// Gone once the check has moved on.
				server.setChecks([
					{ ...missing, state: "installing", update_id: "update-2" },
				]);
				await userEvent
					.setup()
					.click(screen.getByRole("button", { name: "Refresh" }));
				await findRow(claude, "Installing Claude…", "Started earlier.");
				expect(claude.queryByRole("alert")).not.toBeInTheDocument();
			});

			it("says nothing when the CLI is there after all, and reads it again", async () => {
				renderMissing();
				server.actions.cliUpdateInstall.mockImplementation(async () => {
					server.setChecks([installed]);
					server.setStatuses([{ agent: "claude", state: "signed_out" }]);
					throw refusal("already_installed", "claude is already installed");
				});
				const claude = await confirmInstall();

				await findRow(claude, "Version 2.1.290", "Up to date");
				await findRow(claude, "Not signed in", "Sign in to use Claude");
				expect(claude.queryByRole("alert")).not.toBeInTheDocument();
			});
		});

		describe("failed", () => {
			it.each([
				{
					reason: "permission_denied" as const,
					title: "npm can't write its global folder",
					body: "npm config set prefix ~/.npm-global), add its bin to the PATH pockode starts with, restart pockode",
					tryAgain: true,
					instructions: true,
				},
				{
					reason: "not_on_path" as const,
					title: "Claude installed, but Pockode can't find it",
					body: "isn't on the PATH pockode was started with",
					tryAgain: false,
					instructions: false,
				},
				{
					reason: "command_failed" as const,
					detail:
						"npm install --global exited 1\nnpm error 404 Not Found - GET https://registry.npmjs.org/@anthropic-ai%2fclaude-code\nnpm error A complete log of this run can be found in: /home/ada/.npm/_logs/debug.log",
					title: "npm couldn't install Claude",
					body: "npm error 404 Not Found - GET https://registry.npmjs.org/@anthropic-ai%2fclaude-code Install it on the server yourself, or try again.",
					tryAgain: true,
					instructions: true,
				},
				{
					reason: "timeout" as const,
					title: "The install took too long",
					body: "Pockode stopped npm after 10 minutes.",
					tryAgain: true,
					instructions: false,
				},
				{
					reason: "other" as const,
					detail: "claude --version failed: exit status 1",
					title: "Install failed",
					body: "claude --version failed: exit status 1",
					tryAgain: true,
					instructions: true,
				},
			])("explains $reason", async ({
				reason,
				detail,
				title,
				body,
				tryAgain,
				instructions,
			}) => {
				server.setLatestUpdate(
					"claude",
					makeInstall({ phase: "failed", failure: { reason, detail } }),
				);
				renderMissing();

				const claude = await card("Claude");
				await findRow(claude, title, "Not installed");
				const item = screen
					.getByRole("heading", { name: "Claude" })
					.closest("li");
				expect(item).toHaveTextContent(body);
				expect(claude.getByRole("status")).toHaveTextContent(title);
				expect(
					claude.queryByRole("button", { name: "Try again" }) !== null,
				).toBe(tryAgain);
				expect(
					claude.queryByRole("link", { name: /Install instructions/ }) !== null,
				).toBe(instructions);
				expect(claude.getByRole("button", { name: "Dismiss" })).toBeEnabled();
			});

			it("is dismissed back to Not installed", async () => {
				const user = userEvent.setup();
				server.setLatestUpdate(
					"claude",
					makeInstall({ phase: "failed", failure: { reason: "timeout" } }),
				);
				renderMissing();

				const claude = await card("Claude");
				await user.click(
					await claude.findByRole("button", { name: "Dismiss" }),
				);
				expect(server.actions.cliUpdateDismiss).toHaveBeenCalledWith(
					"update-1",
				);
				await findRow(claude, "Not installed", "Installs with npm");
			});

			it("confirms Try again before installing again", async () => {
				const user = userEvent.setup();
				server.setLatestUpdate(
					"claude",
					makeInstall({ phase: "failed", failure: { reason: "timeout" } }),
				);
				renderMissing();

				const claude = await card("Claude");
				await user.click(
					await claude.findByRole("button", { name: "Try again" }),
				);
				expect(
					await screen.findByRole("dialog", { name: "Install Claude?" }),
				).toBeInTheDocument();
				expect(server.actions.cliUpdateInstall).not.toHaveBeenCalled();
			});

			it("keeps Dismiss when Try again is refused for lack of npm", async () => {
				const user = userEvent.setup();
				server.setLatestUpdate(
					"claude",
					makeInstall({ phase: "failed", failure: { reason: "timeout" } }),
				);
				server.actions.cliUpdateInstall.mockRejectedValue(
					refusal("npm_not_found", "npm was not found on the server's PATH"),
				);
				renderMissing();

				const claude = await card("Claude");
				await user.click(
					await claude.findByRole("button", { name: "Try again" }),
				);
				const dialog = await screen.findByRole("dialog", {
					name: "Install Claude?",
				});
				await user.click(
					within(dialog).getByRole("button", { name: "Install" }),
				);

				expect(await claude.findByRole("alert")).toHaveTextContent(
					"npm was not found on the server's PATH",
				);
				expect(
					claude.getByRole("link", { name: /Install instructions/ }),
				).toBeInTheDocument();
				expect(claude.getByRole("button", { name: "Dismiss" })).toBeEnabled();
			});

			it("is not shown once the CLI is there", async () => {
				server.setLatestUpdate(
					"claude",
					makeInstall({ phase: "failed", failure: { reason: "timeout" } }),
				);
				server.setChecks([installed]);
				renderWith({ state: "signed_out" });

				const claude = await card("Claude");
				await findRow(claude, "Version 2.1.290", "Up to date");
				expect(
					claude.queryByText("The install took too long"),
				).not.toBeInTheDocument();
			});
		});
	});
});
