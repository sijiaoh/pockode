import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCliLoginStore } from "../../../lib/cliLoginStore";
import { SWITCH_SCOPE_CAPTION } from "../../../lib/cliProfiles";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	makeOverview,
	resetCliLoginStore,
} from "../../../test/cliAuthFixtures";
import type { CliAuthStatus } from "../../../types/cliAuth";
import type {
	CliProfileInspection,
	CliProfileOverview,
} from "../../../types/cliProfile";
import type { AgentType } from "../../../types/settings";
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
	server.setChecks([
		{
			agent: "claude",
			state: "up_to_date",
			version: "2.1.283",
			channel: "latest",
			running_sessions: 0,
		},
		{
			agent: "codex",
			state: "up_to_date",
			version: "0.153.0",
			channel: "latest",
			running_sessions: 0,
		},
	]);
});

const WORK = "p-work";
const SPARE = "p-spare";

function overview(
	overrides: Partial<CliProfileOverview> = {},
	current = WORK,
): CliProfileOverview {
	return makeOverview({
		clis: [
			{
				agent: "claude",
				...(current ? { current_profile_id: current } : {}),
				profiles: [
					{ id: WORK, name: "Work" },
					{ id: SPARE, name: "Spare" },
				],
			},
			{ agent: "codex", profiles: [] },
		],
		...overrides,
	});
}

function claudeStatus(
	profileId: string,
	status: Omit<CliAuthStatus, "agent" | "profile_id">,
): CliAuthStatus {
	return {
		agent: "claude",
		...(profileId ? { profile_id: profileId } : {}),
		...status,
	};
}

function inspection(
	profileId: string,
	status: Omit<CliAuthStatus, "agent" | "profile_id">,
	extra: Partial<CliProfileInspection> = {},
): CliProfileInspection {
	return { status: claudeStatus(profileId, status), ...extra };
}

const signedIn = (email: string) => ({
	state: "signed_in" as const,
	account: { email, plan: "max" },
});

/** Work current and signed in, Default signed in, Spare signed out. */
function setUpAccounts(
	inspections: CliProfileInspection[] = [
		inspection(WORK, signedIn("ada@work.example")),
		inspection("", signedIn("ada@example.com")),
		inspection(SPARE, { state: "signed_out" }),
	],
	list = overview(),
) {
	server.setOverview(list);
	server.setInspections(inspections);
	server.setStatuses([
		inspections[0]?.status ?? claudeStatus(WORK, { state: "signed_out" }),
		{ agent: "codex", state: "signed_out" },
	]);
}

async function claudeCard() {
	const heading = await screen.findByRole("heading", { name: "Claude" });
	const item = heading.closest("li");
	if (!item) throw new Error("no Claude card");
	return within(item);
}

/** The row an account's `⋯` belongs to. */
async function row(name: string) {
	const menu = await screen.findByRole("button", {
		name: `Actions for ${name}`,
	});
	const box = menu.closest(".min-h-11")?.parentElement;
	if (!(box instanceof HTMLElement)) throw new Error(`no row for ${name}`);
	return within(box);
}

describe("Settings → AI CLIs, accounts", () => {
	it("keeps today's card for a CLI without stored accounts, with Add account", async () => {
		server.setStatuses([
			{ agent: "claude", state: "signed_in", account: { email: "a@b.c" } },
			{ agent: "codex", state: "signed_out" },
		]);
		render(<CliSignInSection />);

		const claude = await claudeCard();
		expect(await claude.findByText("Signed in")).toBeInTheDocument();
		expect(
			await claude.findByRole("button", { name: "Add account" }),
		).toBeInTheDocument();
		expect(claude.queryByText(/current account/)).not.toBeInTheDocument();
		expect(server.actions.cliProfileInspect).not.toHaveBeenCalled();
	});

	it("lists every account with its own state, the current one tagged", async () => {
		setUpAccounts();
		render(<CliSignInSection />);

		const work = await row("Work");
		expect(work.getByText("Current")).toBeInTheDocument();
		expect(await work.findByText("ada@work.example · Max")).toBeInTheDocument();
		// The current account has nothing to switch to.
		expect(
			work.queryByRole("button", { name: "Switch to Work" }),
		).not.toBeInTheDocument();

		const def = await row("Default");
		expect(await def.findByText("ada@example.com · Max")).toBeInTheDocument();
		expect(
			def.getByRole("button", { name: "Switch to Default" }),
		).toBeInTheDocument();

		const spare = await row("Spare");
		expect(await spare.findByText("Not signed in")).toBeInTheDocument();
		expect(
			spare.getByRole("button", { name: "Sign in Spare" }),
		).toBeInTheDocument();

		const claude = await claudeCard();
		// Switching is this Pockode's: the caption never says it reaches others.
		expect(claude.getByText(SWITCH_SCOPE_CAPTION)).toBeInTheDocument();
		for (const id of ["", WORK, SPARE]) {
			expect(server.actions.cliProfileInspect).toHaveBeenCalledWith(
				"claude",
				id,
			);
		}
	});

	// A first list after the upgrade to a choice per server has none.
	it("tags Default current when the list names no current account", async () => {
		setUpAccounts(undefined, overview({}, ""));
		render(<CliSignInSection />);

		expect((await row("Default")).getByText("Current")).toBeInTheDocument();
		expect((await row("Work")).queryByText("Current")).not.toBeInTheDocument();
	});

	it("fills each row when its own read answers", async () => {
		setUpAccounts();
		const inspect = server.actions.cliProfileInspect.getMockImplementation();
		server.actions.cliProfileInspect.mockImplementation(
			async (agent?: AgentType, id?: string) =>
				id === SPARE ? new Promise(() => {}) : (inspect?.(agent, id) ?? []),
		);
		render(<CliSignInSection />);

		const def = await row("Default");
		expect(await def.findByText("ada@example.com · Max")).toBeInTheDocument();
		const spare = await row("Spare");
		expect(
			spare.getByRole("status", { name: "Checking Spare sign-in status" }),
		).toBeInTheDocument();
	});

	it("switches by the row's button and moves Current only when pushed", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		render(<CliSignInSection />);

		const def = await row("Default");
		await user.click(
			await def.findByRole("button", { name: "Switch to Default" }),
		);
		expect(server.actions.cliProfileSwitch).toHaveBeenCalledWith("claude", "");
		expect((await row("Work")).getByText("Current")).toBeInTheDocument();

		// The list sent again unchanged, as for any page subscribing.
		server.pushProfiles(overview());
		expect(await def.findByText("Switching…")).toBeInTheDocument();

		server.pushProfiles(overview({}, ""));
		expect(await def.findByText("Current")).toBeInTheDocument();
		expect((await row("Work")).queryByText("Current")).not.toBeInTheDocument();
		expect(def.queryByText("Switching…")).not.toBeInTheDocument();

		// Switched back from elsewhere: that is not this switch running again.
		server.pushProfiles(overview());
		expect(await (await row("Work")).findByText("Current")).toBeInTheDocument();
		expect(def.queryByText("Switching…")).not.toBeInTheDocument();
		expect(
			def.getByRole("button", { name: "Switch to Default" }),
		).toBeEnabled();
	});

	it("stops waiting for a switch once the list is no longer followed", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		render(<CliSignInSection />);

		const def = await row("Default");
		await user.click(
			await def.findByRole("button", { name: "Switch to Default" }),
		);
		expect(await def.findByText("Switching…")).toBeInTheDocument();

		act(() => useCliLoginStore.setState({ profilesError: "connection lost" }));
		await vi.waitFor(() =>
			expect(def.queryByText("Switching…")).not.toBeInTheDocument(),
		);
	});

	it("adds an account and signs it in, then offers to switch to it", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		server.actions.cliProfileAdd.mockResolvedValue({
			id: "p-new",
			name: "New",
		});
		server.actions.cliLoginStart.mockResolvedValue(
			makeLogin({
				id: "login-new",
				agent: "claude",
				profile_id: "p-new",
				account_kind: "claude_ai",
				url: "https://claude.com/cai/oauth/authorize",
			}),
		);
		server.setInspections([
			inspection(WORK, signedIn("ada@work.example")),
			inspection("", signedIn("ada@example.com")),
			inspection(SPARE, { state: "signed_out" }),
			inspection("p-new", { state: "signed_out" }),
		]);
		render(<CliSignInSection />);

		const claude = await claudeCard();
		await user.click(
			await claude.findByRole("button", { name: "Add account" }),
		);
		expect(
			screen.getByText(
				"You'll sign in to it next. Other projects and cluster nodes on this machine get it too. It becomes the current account only where you switch to it.",
			),
		).toBeInTheDocument();
		await user.type(screen.getByLabelText("Name"), "  New ");
		await user.click(screen.getByRole("button", { name: "Add" }));

		expect(server.actions.cliProfileAdd).toHaveBeenCalledWith("claude", "New");
		expect(
			await screen.findByRole("dialog", { name: "Sign in to Claude · New" }),
		).toBeInTheDocument();
		expect(server.actions.cliLoginStart).toHaveBeenCalledWith(
			"claude",
			undefined,
			"p-new",
		);

		server.push(
			makeLogin({
				id: "login-new",
				agent: "claude",
				profile_id: "p-new",
				revision: 2,
				phase: "succeeded",
			}),
		);
		// A sign-in is the account's, so it reaches every Pockode using it.
		expect(
			await screen.findByText(
				"New is signed in for other projects and cluster nodes on this machine too.",
			),
		).toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", { name: "Switch to New" }),
		);
		expect(server.actions.cliProfileSwitch).toHaveBeenCalledWith(
			"claude",
			"p-new",
		);
	});

	it("shows the server's refusal of a name under the field", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		server.actions.cliProfileAdd.mockRejectedValue(
			new Error('An account named "work" already exists'),
		);
		render(<CliSignInSection />);

		await user.click(
			await (await claudeCard()).findByRole("button", { name: "Add account" }),
		);
		await user.type(screen.getByLabelText("Name"), "work");
		await user.click(screen.getByRole("button", { name: "Add" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			'An account named "work" already exists',
		);
		expect(screen.getByLabelText("Name")).toHaveValue("work");
	});

	it("renames an account from its menu", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		render(<CliSignInSection />);

		await user.click(
			await screen.findByRole("button", { name: "Actions for Spare" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename…" }));
		const field = screen.getByLabelText("Name");
		expect(field).toHaveValue("Spare");
		await user.clear(field);
		await user.type(field, "Side");
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(server.actions.cliProfileRename).toHaveBeenCalledWith(
			"claude",
			SPARE,
			"Side",
		);
	});

	it("draws only the account signing in as signing in; the others wait, Switch kept", async () => {
		setUpAccounts();
		render(<CliSignInSection />);
		const def = await row("Default");
		await def.findByText("ada@example.com · Max");

		const waiting = {
			state: "signing_in" as const,
			login_id: "login-s",
			login_profile_id: SPARE,
		};
		server.setInspections([
			inspection(WORK, waiting),
			inspection("", waiting),
			inspection(SPARE, waiting),
		]);
		server.push(
			makeLogin({ id: "login-s", agent: "claude", profile_id: SPARE }),
		);

		const spare = await row("Spare");
		expect(
			await spare.findByRole("button", { name: "Continue signing in Spare" }),
		).toBeInTheDocument();
		expect(
			await def.findByText("Wait for the sign-in to finish."),
		).toBeInTheDocument();
		expect(
			def.getByRole("button", { name: "Switch to Default" }),
		).toBeInTheDocument();
	});

	it("disables what runs the CLI in the menu while another account signs in", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		server.setLatest(
			makeLogin({ id: "login-s", agent: "claude", profile_id: SPARE }),
		);
		render(<CliSignInSection />);

		await user.click(
			await screen.findByRole("button", { name: "Actions for Default" }),
		);
		expect(
			await screen.findByRole("button", { name: /Sign out/ }),
		).toHaveAttribute("aria-disabled", "true");
		expect(
			within(screen.getByRole("dialog")).getByText(
				"Wait for the sign-in to finish.",
			),
		).toBeInTheDocument();
	});

	describe("signing out", () => {
		it.each([
			[
				"Work",
				"Work is the current Claude account here, so sessions here stop working until you sign in again or switch to another account. Other projects and cluster nodes on this machine using Work stop working too.",
			],
			[
				"Default",
				"Sessions here don't use Default while it isn't the current account, but other projects and cluster nodes on this machine may: they stop working on it until it's signed in again. A turn still running here as Default may fail.",
			],
		])("words the dialog for %s", async (name, message) => {
			const user = userEvent.setup();
			setUpAccounts();
			server.actions.cliAuthLogout.mockResolvedValue(
				claudeStatus(name === "Work" ? WORK : "", { state: "signed_out" }),
			);
			render(<CliSignInSection />);

			await (await row(name)).findByText(/· Max/);
			await user.click(
				screen.getByRole("button", { name: `Actions for ${name}` }),
			);
			await user.click(screen.getByRole("button", { name: "Sign out" }));
			const dialog = await screen.findByRole("dialog", {
				name: `Sign out of ${name}?`,
			});
			expect(dialog).toHaveTextContent(message);
			await user.click(
				within(dialog).getByRole("button", { name: "Sign out" }),
			);
			expect(server.actions.cliAuthLogout).toHaveBeenCalledWith(
				"claude",
				name === "Work" ? WORK : "",
			);
		});

		// Sessions here run as Default there, whichever account is tagged.
		it("words Default as current here where accounts can't be used", async () => {
			const user = userEvent.setup();
			setUpAccounts(
				[
					inspection(WORK, { state: "unavailable", error: "no profiles" }),
					inspection("", signedIn("ada@example.com")),
					inspection(SPARE, { state: "unavailable", error: "no profiles" }),
				],
				overview({ available: false }),
			);
			render(<CliSignInSection />);

			await (await row("Default")).findByText("ada@example.com · Max");
			await user.click(
				screen.getByRole("button", { name: "Actions for Default" }),
			);
			await user.click(screen.getByRole("button", { name: "Sign out" }));
			expect(
				await screen.findByRole("dialog", { name: "Sign out of Default?" }),
			).toHaveTextContent("Default is the current Claude account here");
		});
	});

	describe("removing", () => {
		it("offers removal of the current account, but none of Default", async () => {
			const user = userEvent.setup();
			setUpAccounts();
			render(<CliSignInSection />);

			await user.click(
				await screen.findByRole("button", { name: "Actions for Work" }),
			);
			expect(
				screen.getByRole("button", { name: /Remove account/ }),
			).not.toHaveAttribute("aria-disabled", "true");
			await user.keyboard("{Escape}");

			await user.click(
				screen.getByRole("button", { name: "Actions for Default" }),
			);
			expect(
				screen.queryByRole("button", { name: /Remove account/ }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Rename…" }),
			).not.toBeInTheDocument();
		});

		it.each([
			[
				"in_use",
				{ sessions: [{ session_id: "a" }, { session_id: "b" }] },
				"Spare is still running a turn in 2 sessions here.",
			],
			["updating", {}, "Claude is being updated. Try again when it's done."],
			["removing", {}, "Spare is already being removed."],
			[
				"still_exiting",
				{},
				"Some of Spare's runs here — sessions being stopped, or a one-off task such as drafting a commit message — haven't exited yet. Try again in a few seconds.",
			],
			[
				"sign_out_failed",
				{},
				"Pockode couldn't sign Spare out, so it kept the account.",
			],
			["something_new", {}, "the server's own words"],
			// Refused by a server older than removing the current account.
			["current", {}, "the server's own words"],
		])("words a %s refusal", async (reason, data, text) => {
			const user = userEvent.setup();
			setUpAccounts();
			server.actions.cliProfileRemove.mockRejectedValue(
				new JSONRPCErrorException("the server's own words", -32014, {
					reason,
					...data,
				}),
			);
			render(<CliSignInSection />);

			await user.click(
				await screen.findByRole("button", { name: "Actions for Spare" }),
			);
			await user.click(screen.getByRole("button", { name: /Remove account/ }));
			const dialog = await screen.findByRole("dialog", {
				name: "Remove Spare?",
			});
			await user.click(within(dialog).getByRole("button", { name: "Remove" }));

			expect(server.actions.cliProfileRemove).toHaveBeenCalledWith(
				"claude",
				SPARE,
			);
			const spare = await row("Spare");
			expect(await spare.findByRole("alert")).toHaveTextContent(text);
		});

		it("names the account signing in, and drops the refusal once it is done", async () => {
			const user = userEvent.setup();
			setUpAccounts();
			server.setLatest(
				makeLogin({ id: "login-w", agent: "claude", profile_id: WORK }),
			);
			server.actions.cliProfileRemove.mockRejectedValue(
				new JSONRPCErrorException("busy", -32014, { reason: "signing_in" }),
			);
			render(<CliSignInSection />);

			await user.click(
				await screen.findByRole("button", { name: "Actions for Spare" }),
			);
			await user.click(screen.getByRole("button", { name: /Remove account/ }));
			const dialog = await screen.findByRole("dialog", {
				name: "Remove Spare?",
			});
			await user.click(within(dialog).getByRole("button", { name: "Remove" }));
			const spare = await row("Spare");
			expect(await spare.findByRole("alert")).toHaveTextContent(
				"Claude is signing in Work. Finish or cancel that sign-in, then try again.",
			);

			// Spare reads as it did before; only the sign-in is over.
			server.push(
				makeLogin({
					id: "login-w",
					agent: "claude",
					profile_id: WORK,
					phase: "succeeded",
					revision: 2,
				}),
			);
			await vi.waitFor(() =>
				expect(spare.queryByRole("alert")).not.toBeInTheDocument(),
			);
		});
	});

	describe("removing, beyond refusals", () => {
		async function removeFromMenu(
			user: ReturnType<typeof userEvent.setup>,
			name: string,
		) {
			await user.click(
				await screen.findByRole("button", { name: `Actions for ${name}` }),
			);
			await user.click(screen.getByRole("button", { name: /Remove account/ }));
			const dialog = await screen.findByRole("dialog", {
				name: `Remove ${name}?`,
			});
			await user.click(within(dialog).getByRole("button", { name: "Remove" }));
		}

		async function removeDialog(
			user: ReturnType<typeof userEvent.setup>,
			name: string,
		) {
			await user.click(
				await screen.findByRole("button", { name: `Actions for ${name}` }),
			);
			await user.click(screen.getByRole("button", { name: /Remove account/ }));
			return screen.findByRole("dialog", { name: `Remove ${name}?` });
		}

		const currentHere =
			"Work is the current Claude account here, so sessions here move to Default from their next message.";
		const defaultClause = "Default isn't signed in";

		it("says what removing the current account does here, and to the others", async () => {
			const user = userEvent.setup();
			setUpAccounts();
			render(<CliSignInSection />);
			await (await row("Default")).findByText("ada@example.com · Max");

			const dialog = await removeDialog(user, "Work");
			expect(dialog).toHaveTextContent(currentHere);
			expect(dialog).not.toHaveTextContent(defaultClause);
			expect(dialog).toHaveTextContent(
				"Pockode signs Work out of Claude and deletes it from this machine: other projects and cluster nodes lose it too, and any of them using it moves to Default.",
			);
			await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

			const spare = await removeDialog(user, "Spare");
			expect(spare).not.toHaveTextContent("is the current Claude account");
			expect(spare).toHaveTextContent(
				"Sessions here idle on Spare are stopped",
			);
		});

		it("warns that Default isn't signed in when the current account goes", async () => {
			const user = userEvent.setup();
			setUpAccounts([
				inspection(WORK, signedIn("ada@work.example")),
				inspection("", { state: "signed_out" }),
				inspection(SPARE, { state: "signed_out" }),
			]);
			render(<CliSignInSection />);
			await (await row("Default")).findByText("Not signed in");

			const dialog = await removeDialog(user, "Work");
			expect(dialog).toHaveTextContent(
				`${currentHere} Default isn't signed in, so they won't work until you sign it in or switch to another account.`,
			);
		});

		// Sessions there already run as Default whichever account is chosen.
		it("says nothing of moving to Default where accounts can't be used", async () => {
			const user = userEvent.setup();
			setUpAccounts(
				[
					inspection(WORK, { state: "unavailable", error: "no profiles" }),
					inspection("", { state: "signed_out" }),
					inspection(SPARE, { state: "unavailable", error: "no profiles" }),
				],
				overview({ available: false }),
			);
			render(<CliSignInSection />);

			const dialog = await removeDialog(user, "Work");
			expect(dialog).not.toHaveTextContent("is the current Claude account");
			expect(dialog).not.toHaveTextContent(defaultClause);
		});

		it("keeps Current on the account being removed and says new turns use Default", async () => {
			const user = userEvent.setup();
			setUpAccounts();
			let refuse: () => void = () => {};
			server.actions.cliProfileRemove.mockImplementation(
				() =>
					new Promise<void>((_, reject) => {
						refuse = () =>
							reject(
								new JSONRPCErrorException("busy", -32014, {
									reason: "in_use",
									sessions: [{ session_id: "a" }],
								}),
							);
					}),
			);
			render(<CliSignInSection />);
			const work = await row("Work");
			await work.findByText("ada@work.example · Max");

			await removeFromMenu(user, "Work");
			expect(
				await work.findByText("New turns here use Default."),
			).toBeInTheDocument();
			expect(work.getByText("Current")).toBeInTheDocument();
			expect(work.getByText("Removing…")).toBeInTheDocument();

			act(() => refuse());
			expect(await work.findByRole("alert")).toHaveTextContent(
				"Work is still running a turn in 1 session here.",
			);
			expect(work.getByText("ada@work.example · Max")).toBeInTheDocument();
			expect(work.getByText("Current")).toBeInTheDocument();
			expect(
				work.queryByText("New turns here use Default."),
			).not.toBeInTheDocument();
		});

		it("drops the note once another account is switched to mid-removal", async () => {
			const user = userEvent.setup();
			setUpAccounts();
			server.actions.cliProfileRemove.mockImplementation(
				() => new Promise<void>(() => {}),
			);
			render(<CliSignInSection />);
			const work = await row("Work");

			await removeFromMenu(user, "Work");
			expect(
				await work.findByText("New turns here use Default."),
			).toBeInTheDocument();
			const def = await row("Default");
			await user.click(def.getByRole("button", { name: "Switch to Default" }));
			expect(server.actions.cliProfileSwitch).toHaveBeenCalledWith(
				"claude",
				"",
			);

			server.pushProfiles(overview({}, ""));
			expect(await def.findByText("Current")).toBeInTheDocument();
			expect(
				work.queryByText("New turns here use Default."),
			).not.toBeInTheDocument();
			expect(work.getByText("Removing…")).toBeInTheDocument();
		});

		it("moves Current to Default in the push that takes the removed account away", async () => {
			const user = userEvent.setup();
			setUpAccounts();
			render(<CliSignInSection />);

			await removeFromMenu(user, "Work");
			server.pushProfiles(
				makeOverview({
					clis: [
						{ agent: "claude", profiles: [{ id: SPARE, name: "Spare" }] },
						{ agent: "codex", profiles: [] },
					],
				}),
			);
			await vi.waitFor(() =>
				expect(
					screen.queryByRole("button", { name: "Actions for Work" }),
				).not.toBeInTheDocument(),
			);
			expect((await row("Default")).getByText("Current")).toBeInTheDocument();
			expect(screen.queryByText(/New turns here/)).not.toBeInTheDocument();
		});

		it("keeps the row removing until the list drops it, then returns to one account", async () => {
			const user = userEvent.setup();
			setUpAccounts(undefined, overview({}, ""));
			render(<CliSignInSection />);

			await removeFromMenu(user, "Work");
			const work = await row("Work");
			expect(await work.findByText("Removing…")).toBeInTheDocument();

			server.pushProfiles(
				makeOverview({
					clis: [
						{
							agent: "claude",
							profiles: [{ id: SPARE, name: "Spare" }],
						},
						{ agent: "codex", profiles: [] },
					],
				}),
			);
			expect(
				await screen.findByRole("button", { name: "Actions for Spare" }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "Actions for Work" }),
			).not.toBeInTheDocument();

			await removeFromMenu(user, "Spare");
			server.pushProfiles(makeOverview());
			expect(
				await (await claudeCard()).findByRole("button", { name: "Sign out" }),
			).toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: /^Actions for/ }),
			).not.toBeInTheDocument();
		});

		it("follows two removals on their own", async () => {
			const user = userEvent.setup();
			setUpAccounts(undefined, overview({}, ""));
			let finishWork: () => void = () => {};
			server.actions.cliProfileRemove.mockImplementation(
				async (_agent: AgentType, id: string): Promise<void> => {
					if (id === WORK) {
						await new Promise<void>((resolve) => {
							finishWork = resolve;
						});
						throw new Error("work failed");
					}
					await new Promise(() => {});
				},
			);
			render(<CliSignInSection />);

			await removeFromMenu(user, "Work");
			await removeFromMenu(user, "Spare");
			const work = await row("Work");
			const spare = await row("Spare");
			expect(work.getByText("Removing…")).toBeInTheDocument();
			expect(spare.getByText("Removing…")).toBeInTheDocument();

			finishWork();
			expect(await work.findByRole("alert")).toHaveTextContent("work failed");
			expect(spare.getByText("Removing…")).toBeInTheDocument();
		});

		it("says on the card when the account left the list but its folder stayed", async () => {
			const user = userEvent.setup();
			setUpAccounts(undefined, overview({}, ""));
			server.actions.cliProfileRemove.mockRejectedValue(
				new JSONRPCErrorException(
					"remove /x/p-spare: permission denied",
					-32603,
				),
			);
			render(<CliSignInSection />);

			await removeFromMenu(user, "Spare");
			server.pushProfiles(
				makeOverview({
					clis: [
						{ agent: "claude", profiles: [{ id: WORK, name: "Work" }] },
						{ agent: "codex", profiles: [] },
					],
				}),
			);
			expect(
				await (await claudeCard()).findByText(
					"Spare was removed, but its folder couldn't be deleted: remove /x/p-spare: permission denied",
				),
			).toBeInTheDocument();
		});
	});

	it("says nothing of a folder when the connection drops mid-removal", async () => {
		const user = userEvent.setup();
		setUpAccounts(undefined, overview({}, ""));
		// What json-rpc-2.0 rejects pending requests with on a lost connection.
		server.actions.cliProfileRemove.mockRejectedValue(
			new JSONRPCErrorException("Connection lost", 0),
		);
		render(<CliSignInSection />);

		await user.click(
			await screen.findByRole("button", { name: "Actions for Spare" }),
		);
		await user.click(screen.getByRole("button", { name: /Remove account/ }));
		const dialog = await screen.findByRole("dialog", {
			name: "Remove Spare?",
		});
		await user.click(within(dialog).getByRole("button", { name: "Remove" }));
		expect(await (await row("Spare")).findByRole("alert")).toHaveTextContent(
			"Connection lost",
		);
		// The server finished the removal after all.
		server.pushProfiles(
			makeOverview({
				clis: [
					{ agent: "claude", profiles: [{ id: WORK, name: "Work" }] },
					{ agent: "codex", profiles: [] },
				],
			}),
		);
		await vi.waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Actions for Spare" }),
			).not.toBeInTheDocument(),
		);
		expect(screen.queryByText(/folder couldn't be deleted/)).toBeNull();
	});

	it("shows a failed switch on its row", async () => {
		const user = userEvent.setup();
		setUpAccounts();
		server.actions.cliProfileSwitch.mockRejectedValue(
			new Error("no config dir"),
		);
		render(<CliSignInSection />);

		const def = await row("Default");
		await user.click(
			await def.findByRole("button", { name: "Switch to Default" }),
		);
		expect(await def.findByRole("alert")).toHaveTextContent("no config dir");
	});

	describe("explaining why", () => {
		const env = {
			state: "external" as const,
			external: { kind: "api_key" as const, source: "ANTHROPIC_API_KEY" },
		};

		it("says once when every account uses the same outside credentials", async () => {
			setUpAccounts([
				inspection(WORK, env),
				inspection("", env),
				inspection(SPARE, env),
			]);
			render(<CliSignInSection />);

			const claude = await claudeCard();
			expect(
				await claude.findByText(/so switching accounts doesn't change/),
			).toBeInTheDocument();
			expect(claude.queryByText(/^Using/)).not.toBeInTheDocument();
		});

		it("says nothing for the card when only one account is managed outside", async () => {
			setUpAccounts([
				inspection(WORK, signedIn("ada@work.example")),
				inspection("", env),
				inspection(SPARE, { state: "signed_out" }),
			]);
			render(<CliSignInSection />);

			const def = await row("Default");
			expect(
				await def.findByText(/Managed outside Pockode/),
			).toBeInTheDocument();
			expect(
				screen.queryByText(/so switching accounts doesn't change/),
			).not.toBeInTheDocument();
		});

		it("says when the machine can only use default accounts, and dims the others", async () => {
			setUpAccounts(
				[
					inspection(WORK, { state: "unavailable", error: "no profiles" }),
					inspection("", signedIn("ada@example.com")),
					inspection(SPARE, { state: "unavailable", error: "no profiles" }),
				],
				overview({
					available: false,
					unavailable_reason: "Turn on Developer Mode.",
				}),
			);
			render(<CliSignInSection />);

			expect(
				await screen.findByText(
					"This machine can only use each CLI's default account. Turn on Developer Mode.",
				),
			).toBeInTheDocument();
			const work = await row("Work");
			expect(
				work.getByText("Can't be used on this machine"),
			).toBeInTheDocument();
			expect(
				work.queryByRole("button", { name: "Retry reading Work" }),
			).not.toBeInTheDocument();
			expect(
				screen.getByText(
					"Pockode here uses Default whatever is current until it can use accounts.",
				),
			).toBeInTheDocument();
		});

		it("keeps an account this machine can't use dimmed while another signs in", async () => {
			setUpAccounts(
				[
					inspection(WORK, { state: "unavailable", error: "no profiles" }),
					inspection("", { state: "signed_out" }),
					inspection(SPARE, { state: "unavailable", error: "no profiles" }),
				],
				overview({ available: false }),
			);
			server.setLatest(makeLogin({ id: "login-d", agent: "claude" }));
			render(<CliSignInSection />);

			expect(
				await (await row("Default")).findByRole("button", {
					name: "Continue signing in Default",
				}),
			).toBeInTheDocument();
			const work = await row("Work");
			expect(
				work.getByText("Can't be used on this machine"),
			).toBeInTheDocument();
			expect(
				work.queryByText("Wait for the sign-in to finish."),
			).not.toBeInTheDocument();
		});

		it("gives the reason instead of a name field when the machine has no accounts", async () => {
			const user = userEvent.setup();
			server.setOverview(
				makeOverview({ available: false, unavailable_reason: "Why not." }),
			);
			server.setStatuses([
				{ agent: "claude", state: "signed_out" },
				{ agent: "codex", state: "signed_out" },
			]);
			render(<CliSignInSection />);

			expect(
				screen.queryByText(/can only use each CLI's default account/),
			).not.toBeInTheDocument();
			await user.click(
				await (await claudeCard()).findByRole("button", {
					name: "Add account",
				}),
			);
			expect(
				await screen.findByText(
					"This machine can only use each CLI's default account. Why not.",
				),
			).toBeInTheDocument();
			expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
		});

		it("lists what an account doesn't share", async () => {
			const user = userEvent.setup();
			setUpAccounts([
				inspection(WORK, signedIn("ada@work.example")),
				inspection("", signedIn("ada@example.com")),
				inspection(
					SPARE,
					{ state: "signed_out" },
					{
						conflicts: [
							{ name: "history.jsonl", path: "/x/p-spare/history.jsonl" },
						],
					},
				),
			]);
			render(<CliSignInSection />);

			const spare = await row("Spare");
			expect(
				await spare.findByText(/doesn't share 1 item with your other accounts/),
			).toBeInTheDocument();
			await user.click(spare.getByRole("button", { name: "Details" }));
			expect(
				spare.getByText("history.jsonl · /x/p-spare/history.jsonl"),
			).toBeInTheDocument();
		});
	});
});
