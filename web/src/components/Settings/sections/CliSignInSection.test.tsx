import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	makeUpdate,
	resetCliLoginStore,
} from "../../../test/cliAuthFixtures";
import type { CliAuthStatus } from "../../../types/cliAuth";
import type { CliUpdateCheck } from "../../../types/cliUpdate";
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
		expect(
			await claude.findByText("Signed in · ada@example.com · Max"),
		).toBeInTheDocument();
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
			[{ state: "up_to_date" as const }, "Version 2.1.283 · Up to date"],
			[{}, "Version 2.1.283 · 2.1.290 available"],
			[{ channel: "stable" }, "Version 2.1.283 · 2.1.290 available on stable"],
		])("draws a check of %o", async (check, line) => {
			renderChecked(check);
			const claude = await card("Claude");
			expect(await claude.findByText(line)).toBeInTheDocument();
		});

		// "Couldn't check" is never folded into the benign "Up to date".
		it("says it couldn't check when the latest version couldn't be read", async () => {
			renderChecked({
				state: "unavailable",
				latest_version: undefined,
				error: "registry.npmjs.org: no such host",
			});
			const claude = await card("Claude");
			expect(
				await claude.findByText("Version 2.1.283 · Couldn't check for updates"),
			).toBeInTheDocument();
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
			expect(
				await claude.findByText("Version 2.1.283 · Couldn't check for updates"),
			).toBeInTheDocument();
			expect(claude.getByText("Request timed out")).toBeInTheDocument();
		});

		it.each([
			[
				"an unreadable version",
				{ state: "unavailable" as const, version: undefined, error: "exit 1" },
				"Couldn't read the installed version",
			],
			[
				"a release this install hasn't got",
				{ state: "not_yet_available" as const },
				"Version 2.1.283 · 2.1.290 is out",
			],
		])("offers no update for %s", async (_, check, line) => {
			renderChecked(check);
			const claude = await card("Claude");
			expect(await claude.findByText(line)).toBeInTheDocument();
			expect(
				claude.queryByRole("button", { name: "Update" }),
			).not.toBeInTheDocument();
		});

		it("draws no version row for a CLI that isn't installed", async () => {
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
			expect(
				await claude.findByText("Version 2.1.283 · Up to date"),
			).toBeInTheDocument();
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
			expect(
				claude.getByText("Signed in · ada@example.com"),
			).toBeInTheDocument();
			expect(
				claude.getByText("Wait for the update to finish."),
			).toBeInTheDocument();
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
			expect(
				await claude.findByText("Sign-in status is checked after the update."),
			).toBeInTheDocument();
			expect(claude.queryByRole("button")).not.toBeInTheDocument();
		});

		it("holds Update off while a sign-in to the CLI runs", async () => {
			server.setLatest(makeLogin({ id: "claude-1", agent: "claude" }));
			renderChecked({}, { state: "signing_in", login_id: "claude-1" });

			const claude = await card("Claude");
			expect(
				await claude.findByText("Finish or cancel the sign-in first."),
			).toBeInTheDocument();
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

			expect(
				await claude.findByText("Updated from 2.1.283 to 2.1.290", {
					selector: "p",
				}),
			).toBeInTheDocument();
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
			expect(
				await claude.findByText("Claude was already up to date (2.1.283)", {
					selector: "p",
				}),
			).toBeInTheDocument();
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
			expect(
				await claude.findByText("Updated from 2.1.283 to 2.1.290", {
					selector: "p",
				}),
			).toBeInTheDocument();

			unmount();
			render(<CliSignInSection />);
			const again = await card("Claude");
			expect(
				await again.findByText("Version 2.1.290 · Up to date"),
			).toBeInTheDocument();
			expect(again.queryByText(/Updated from/)).not.toBeInTheDocument();
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
			expect(
				await claude.findByText("Version 2.1.283 · Checking for updates…"),
			).toBeInTheDocument();
		});

		it("leaves a success that ended before the page came to the screen that saw it", async () => {
			server.setLatestUpdate(
				"claude",
				makeUpdate({ phase: "succeeded", to_version: "2.1.290" }),
			);
			renderChecked({ state: "up_to_date", version: "2.1.290" });

			const claude = await card("Claude");
			expect(
				await claude.findByText("Version 2.1.290 · Up to date"),
			).toBeInTheDocument();
			expect(claude.queryByText(/Updated from/)).not.toBeInTheDocument();
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
				expect(
					await claude.findByText("Version 2.1.283 · 2.1.290 available"),
				).toBeInTheDocument();
			});

			// Someone changed the CLI since: the failure is about a version gone.
			it("is not shown once the installed version has moved from where the update left it", async () => {
				server.setLatestUpdate(
					"claude",
					makeUpdate({ phase: "failed", failure: { reason: "timeout" } }),
				);
				renderChecked({ state: "up_to_date", version: "2.1.290" });

				const claude = await card("Claude");
				expect(
					await claude.findByText("Version 2.1.290 · Up to date"),
				).toBeInTheDocument();
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

			it("points a CLI that went missing at its install page", async () => {
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
				expect(
					claude.getAllByRole("link", { name: /Install instructions/ }),
				).not.toHaveLength(0);
				expect(
					claude.getByRole("button", { name: "Dismiss" }),
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
				const row = heading.closest("div.border-t");
				if (!(row instanceof HTMLElement)) throw new Error("no version row");
				expect(row).toHaveTextContent(body);
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
});
