import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	makeOverview,
	makeUpdate,
	resetCliLoginStore,
} from "../test/cliAuthFixtures";
import type { CliAuthStatus } from "../types/cliAuth";
import type { CliProfileInspection } from "../types/cliProfile";
import { cliLoginActions, useCliLoginStore } from "./cliLoginStore";

const ws = vi.hoisted(() => ({ actions: {} as Record<string, unknown> }));

vi.mock("./wsStore", () => ({
	useWSStore: { getState: () => ({ actions: ws.actions }) },
}));

let server: FakeCliAuth;

beforeEach(() => {
	resetCliLoginStore();
	server = createFakeCliAuth();
	ws.actions = server.actions;
});

describe("cliLoginStore", () => {
	// A reply and a notification about the same sign-in are sent separately and
	// can arrive in either order; the older copy must not win.
	it("keeps the higher revision of one sign-in", () => {
		cliLoginActions.applyLogin(
			"claude",
			makeLogin({ agent: "claude", revision: 3, phase: "waiting" }),
		);
		cliLoginActions.applyLogin(
			"claude",
			makeLogin({ agent: "claude", revision: 2, phase: "verifying" }),
		);

		expect(useCliLoginStore.getState().logins.claude?.phase).toBe("waiting");
	});

	// Revisions restart with the server, so they say nothing across two ids.
	it("replaces a sign-in with a different one whatever its revision", () => {
		cliLoginActions.applyLogin("codex", makeLogin({ id: "a", revision: 9 }));
		cliLoginActions.applyLogin("codex", makeLogin({ id: "b", revision: 1 }));
		expect(useCliLoginStore.getState().logins.codex?.id).toBe("b");

		cliLoginActions.applyLogin("codex", null);
		expect(useCliLoginStore.getState().logins.codex).toBeUndefined();
	});

	// A cancel's reply names the sign-in it was sent for, which a newer one may
	// have replaced since; taken as current, it would hide the running one.
	it("does not let a reply about an older sign-in displace the current one", () => {
		cliLoginActions.applyLogin("codex", makeLogin({ id: "new" }));
		cliLoginActions.applyLogin(
			"codex",
			makeLogin({ id: "old", revision: 5, phase: "failed" }),
			false,
		);
		expect(useCliLoginStore.getState().logins.codex?.id).toBe("new");
	});

	// Guessing the benign state would send the user into a sign-in that cannot
	// fix what is wrong.
	it("records a failed status read as unavailable, never signed out", async () => {
		server.actions.cliAuthStatus.mockRejectedValueOnce(
			new Error("Request timed out"),
		);

		await cliLoginActions.refreshStatus();

		expect(useCliLoginStore.getState().statuses).toEqual({
			claude: {
				agent: "claude",
				state: "unavailable",
				error: "Request timed out",
			},
			codex: {
				agent: "codex",
				state: "unavailable",
				error: "Request timed out",
			},
		});
	});

	it("lets the newest read land when two overlap", async () => {
		let answerFirst: (value: CliAuthStatus[]) => void = () => {};
		server.actions.cliAuthStatus.mockImplementationOnce(
			() =>
				new Promise<CliAuthStatus[]>((resolve) => {
					answerFirst = resolve;
				}),
		);
		const first = cliLoginActions.refreshStatus("codex");
		server.setStatuses([{ agent: "codex", state: "signed_out" }]);
		await cliLoginActions.refreshStatus("codex");

		answerFirst([{ agent: "codex", state: "signed_in" }]);
		await first;

		expect(useCliLoginStore.getState().statuses.codex?.state).toBe(
			"signed_out",
		);
		expect(useCliLoginStore.getState().reading.codex).toBe(false);
	});

	// The card reads status, never the sign-in's `account`, so an ending it
	// watched happen has to be followed by a fresh read.
	it("reads status again when a sign-in it was following ends", async () => {
		useCliLoginStore.setState({
			statuses: {
				codex: { agent: "codex", state: "signing_in", login_id: "a" },
			},
		});
		cliLoginActions.applyLogin("codex", makeLogin({ id: "a", revision: 1 }));
		expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();

		server.setStatuses([{ agent: "codex", state: "signed_in" }]);
		cliLoginActions.applyLogin(
			"codex",
			makeLogin({ id: "a", revision: 2, phase: "succeeded" }),
		);

		await vi.waitFor(() =>
			expect(useCliLoginStore.getState().statuses.codex?.state).toBe(
				"signed_in",
			),
		);
	});

	// The last sign-in to end is kept by the server and handed to every fresh
	// subscribe; it ended before the status on screen was read.
	it("does not re-read status for a sign-in that was already over", () => {
		useCliLoginStore.setState({
			statuses: { codex: { agent: "codex", state: "signed_out" } },
		});
		cliLoginActions.applyLogin(
			"codex",
			makeLogin({ id: "old", phase: "failed" }),
		);
		expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
	});

	it("keeps a newer status from being overwritten by a read started before a sign-out", async () => {
		let answerRead: (value: CliAuthStatus[]) => void = () => {};
		server.actions.cliAuthStatus.mockImplementationOnce(
			() =>
				new Promise<CliAuthStatus[]>((resolve) => {
					answerRead = resolve;
				}),
		);
		const read = cliLoginActions.refreshStatus("claude");
		server.actions.cliAuthLogout.mockResolvedValueOnce({
			agent: "claude",
			state: "signed_out",
		});
		await cliLoginActions.logout("claude");

		answerRead([{ agent: "claude", state: "signed_in" }]);
		await read;

		expect(useCliLoginStore.getState().statuses.claude?.state).toBe(
			"signed_out",
		);
	});

	describe("updates", () => {
		it("keeps the higher revision of one update", () => {
			cliLoginActions.applyUpdate(
				"claude",
				makeUpdate({ revision: 3, phase: "failed" }),
			);
			cliLoginActions.applyUpdate(
				"claude",
				makeUpdate({ revision: 2, phase: "running" }),
			);
			expect(useCliLoginStore.getState().updates.claude?.phase).toBe("failed");
		});

		// A check that could not be made must not read as "up to date", nor wipe
		// what the last check that did answer said.
		it("keeps the last check when a check request fails", async () => {
			server.setChecks([
				{
					agent: "claude",
					state: "update_available",
					version: "2.1.283",
					latest_version: "2.1.290",
					channel: "latest",
					running_sessions: 0,
				},
			]);
			await cliLoginActions.refreshCheck("claude");
			server.actions.cliUpdateCheck.mockRejectedValueOnce(
				new Error("Connection lost"),
			);
			await cliLoginActions.refreshCheck("claude");

			const state = useCliLoginStore.getState();
			expect(state.checks.claude?.state).toBe("update_available");
			expect(state.checkErrors.claude).toBe("Connection lost");
			expect(state.checking.claude).toBe(false);
		});

		// While the CLI is replaced its sign-in is not read; the card keeps the
		// last state it did read, and both are read again once it has ended.
		it("holds the last sign-in through an update and reads both after it", async () => {
			server.setStatuses([{ agent: "claude", state: "signed_in" }]);
			await cliLoginActions.refreshStatus("claude");
			server.setStatuses([
				{ agent: "claude", state: "updating", update_id: "update-1" },
			]);
			await cliLoginActions.refreshStatus("claude");
			expect(useCliLoginStore.getState().settledStatuses.claude?.state).toBe(
				"signed_in",
			);

			cliLoginActions.applyUpdate("claude", makeUpdate());
			// A request that fails meanwhile says nothing about the sign-in.
			server.actions.cliAuthStatus.mockRejectedValueOnce(
				new Error("Connection lost"),
			);
			await cliLoginActions.refreshStatus("claude");
			expect(useCliLoginStore.getState().settledStatuses.claude?.state).toBe(
				"signed_in",
			);

			server.setStatuses([{ agent: "claude", state: "signed_in" }]);
			server.setChecks([
				{
					agent: "claude",
					state: "up_to_date",
					version: "2.1.290",
					channel: "latest",
					running_sessions: 0,
				},
			]);
			cliLoginActions.applyUpdate(
				"claude",
				makeUpdate({ revision: 2, phase: "succeeded", to_version: "2.1.290" }),
			);

			await vi.waitFor(() => {
				const state = useCliLoginStore.getState();
				expect(state.statuses.claude?.state).toBe("signed_in");
				expect(state.checks.claude?.version).toBe("2.1.290");
			});
			expect(useCliLoginStore.getState().updatesSeenEnding).toEqual([
				"update-1",
			]);
		});

		// Outside Settings nothing follows the update to its end, so a surface
		// that only needs *a* status does not settle for `updating`.
		it("does not take `updating` as a status to keep", async () => {
			server.setStatuses([
				{ agent: "claude", state: "updating", update_id: "update-1" },
			]);
			await cliLoginActions.refreshStatus("claude");
			server.setStatuses([{ agent: "claude", state: "signed_in" }]);

			cliLoginActions.ensureStatus("claude");

			await vi.waitFor(() =>
				expect(useCliLoginStore.getState().statuses.claude?.state).toBe(
					"signed_in",
				),
			);
		});

		// A Refresh sent while the update ran is answered `updating`, and can land
		// after the update has ended: it must not leave the card held still.
		it("reads status again when a read answered mid-update lands after the end", async () => {
			let answer: (value: CliAuthStatus[]) => void = () => {};
			server.actions.cliAuthStatus.mockImplementationOnce(
				() =>
					new Promise<CliAuthStatus[]>((resolve) => {
						answer = resolve;
					}),
			);
			server.setStatuses([{ agent: "claude", state: "signed_in" }]);
			// After a reload: the first copy of the update this page gets is the
			// ended one, so there is no ending it saw to re-read on.
			const read = cliLoginActions.refreshStatus("claude");
			cliLoginActions.applyUpdate(
				"claude",
				makeUpdate({ id: "stale-status", revision: 2, phase: "failed" }),
			);
			answer([
				{ agent: "claude", state: "updating", update_id: "stale-status" },
			]);
			await read;

			await vi.waitFor(() =>
				expect(useCliLoginStore.getState().statuses.claude?.state).toBe(
					"signed_in",
				),
			);
		});

		// Changes are collapsed on the server, so a fast update can reach this
		// page ended before its start's reply does.
		it("counts an update it started as seen ending, however the copies arrive", async () => {
			const ended = makeUpdate({
				id: "fast",
				revision: 2,
				phase: "succeeded",
				to_version: "2.1.290",
			});
			server.actions.cliUpdateStart.mockImplementation(async () => {
				cliLoginActions.applyUpdate("claude", ended);
				return makeUpdate({ id: "fast", revision: 1 });
			});

			await cliLoginActions.startUpdate("claude");

			expect(useCliLoginStore.getState().updatesSeenEnding).toEqual(["fast"]);
			expect(server.actions.cliUpdateCheck).toHaveBeenCalledWith("claude");
		});

		// The server keeps the last update to end and hands it to every fresh
		// subscribe; its success was confirmed on the screen that watched it.
		it("does not count an update that was already over as seen ending", () => {
			cliLoginActions.applyUpdate(
				"claude",
				makeUpdate({ phase: "succeeded", to_version: "2.1.290" }),
			);
			expect(useCliLoginStore.getState().updatesSeenEnding).toEqual([]);
			expect(server.actions.cliUpdateCheck).not.toHaveBeenCalled();
		});
	});

	describe("installs", () => {
		const notInstalled = {
			agent: "claude",
			state: "not_installed",
			channel: "latest",
			running_sessions: 0,
		} as const;
		const installed = {
			agent: "claude",
			state: "up_to_date",
			version: "2.1.290",
			channel: "latest",
			running_sessions: 0,
		} as const;

		// An install is an update of kind "install": it ends the same way, and
		// the check that answered `installing` is read again once it has.
		it("reads the check and status again when an install it started ends", async () => {
			server.setChecks([
				{ ...notInstalled, state: "installing", update_id: "install-1" },
			]);
			await cliLoginActions.refreshCheck("claude");
			const install = makeUpdate({
				id: "install-1",
				kind: "install",
				from_version: undefined,
				binary_path: undefined,
			});
			server.actions.cliUpdateInstall.mockResolvedValue(install);

			await cliLoginActions.startInstall("claude");
			expect(server.actions.cliUpdateInstall).toHaveBeenCalledWith("claude");
			expect(useCliLoginStore.getState().updatesStartedHere).toEqual([
				"install-1",
			]);

			server.setChecks([installed]);
			server.setStatuses([{ agent: "claude", state: "signed_out" }]);
			cliLoginActions.applyUpdate("claude", {
				...install,
				revision: 2,
				phase: "succeeded",
				to_version: "2.1.290",
				binary_path: "/home/ada/.npm-global/bin/claude",
			});

			await vi.waitFor(() => {
				const state = useCliLoginStore.getState();
				expect(state.checks.claude?.state).toBe("up_to_date");
				expect(state.statuses.claude?.state).toBe("signed_out");
			});
			expect(useCliLoginStore.getState().updatesSeenEnding).toEqual([
				"install-1",
			]);
		});

		// The card offered an install because it read `not_installed`; the
		// server finding the CLI means that read is stale.
		it("reads again when the server says the CLI is already installed", async () => {
			server.setChecks([notInstalled]);
			await cliLoginActions.refreshCheck("claude");
			server.setChecks([installed]);
			server.actions.cliUpdateInstall.mockRejectedValue(
				new JSONRPCErrorException("claude is already installed", -32003, {
					reason: "already_installed",
				}),
			);

			await expect(cliLoginActions.startInstall("claude")).rejects.toThrow(
				"claude is already installed",
			);

			await vi.waitFor(() =>
				expect(useCliLoginStore.getState().checks.claude?.state).toBe(
					"up_to_date",
				),
			);
			expect(server.actions.cliAuthStatus).toHaveBeenCalledWith("claude");
		});

		it("leaves the reads alone on any other refusal", async () => {
			server.actions.cliUpdateInstall.mockRejectedValue(
				new JSONRPCErrorException(
					"cannot run the official installer: claude's official installer (https://claude.ai/install.sh) downloads with curl or wget, and neither is on the PATH of the process running pockode; install it, then restart pockode",
					-32003,
					{ reason: "installer_tool_not_found" },
				),
			);

			await expect(cliLoginActions.startInstall("claude")).rejects.toThrow();

			expect(server.actions.cliUpdateCheck).not.toHaveBeenCalled();
			expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
		});
	});

	describe("profiles", () => {
		const WORK = "0199a000-0000-7000-8000-000000000001";
		const withWork = makeOverview({
			clis: [
				{ agent: "claude", profiles: [] },
				{ agent: "codex", profiles: [{ id: WORK, name: "Work" }] },
			],
		});

		const inspections = () => useCliLoginStore.getState().inspections.codex;

		// A Codex read takes seconds; one slow profile must not hold the rest.
		it("lands each profile's inspection on its own", async () => {
			cliLoginActions.applyProfiles(withWork);
			let answerWork: (value: CliProfileInspection[]) => void = () => {};
			server.actions.cliProfileInspect.mockImplementation(
				async (_agent?: unknown, profileId?: string) =>
					profileId === WORK
						? new Promise<CliProfileInspection[]>((resolve) => {
								answerWork = resolve;
							})
						: [{ status: { agent: "codex", state: "signed_in" } }],
			);

			const all = cliLoginActions.inspectProfiles("codex");

			await vi.waitFor(() =>
				expect(inspections()?.[""]?.status.state).toBe("signed_in"),
			);
			expect(inspections()?.[WORK]).toBeUndefined();
			expect(useCliLoginStore.getState().inspecting.codex).toEqual({
				[WORK]: true,
			});

			answerWork([
				{
					status: { agent: "codex", profile_id: WORK, state: "signed_out" },
					conflicts: [{ name: "config.toml", path: "/p/config.toml" }],
				},
			]);
			await all;
			expect(inspections()?.[WORK]?.conflicts).toHaveLength(1);
			expect(useCliLoginStore.getState().inspecting.codex).toEqual({});
		});

		it("records a failed inspection as unavailable, for its profile", async () => {
			server.actions.cliProfileInspect.mockRejectedValueOnce(
				new Error("Request timed out"),
			);
			await cliLoginActions.inspectProfile("codex", WORK);
			expect(inspections()?.[WORK]?.status).toEqual({
				agent: "codex",
				profile_id: WORK,
				state: "unavailable",
				error: "Request timed out",
			});
		});

		// The status read after a sign-out is newer than any read in flight, and
		// is the current profile's too when that is the one signed out.
		it("takes a profile's sign-out wherever that profile is shown", async () => {
			useCliLoginStore.setState({
				statuses: {
					codex: { agent: "codex", profile_id: WORK, state: "signed_in" },
				},
				inspections: {
					codex: {
						[WORK]: {
							status: { agent: "codex", profile_id: WORK, state: "signed_in" },
							conflicts: [{ name: "config.toml", path: "/p/config.toml" }],
						},
					},
				},
			});
			const signedOut: CliAuthStatus = {
				agent: "codex",
				profile_id: WORK,
				state: "signed_out",
			};
			server.actions.cliAuthLogout.mockResolvedValueOnce(signedOut);

			await cliLoginActions.logout("codex", WORK);

			expect(server.actions.cliAuthLogout).toHaveBeenCalledWith("codex", WORK);
			expect(useCliLoginStore.getState().statuses.codex).toEqual(signedOut);
			expect(inspections()?.[WORK]).toEqual({
				status: signedOut,
				conflicts: [{ name: "config.toml", path: "/p/config.toml" }],
			});
		});

		it("does not take another profile's sign-out as the current one's", async () => {
			const current: CliAuthStatus = { agent: "codex", state: "signed_in" };
			useCliLoginStore.setState({ statuses: { codex: current } });
			server.actions.cliAuthLogout.mockResolvedValueOnce({
				agent: "codex",
				profile_id: WORK,
				state: "signed_out",
			});

			await cliLoginActions.logout("codex", WORK);

			expect(useCliLoginStore.getState().statuses.codex).toBe(current);
		});

		// Sessions run as the profile now current; the status held was another's.
		it("reads the current status again when another profile becomes current", async () => {
			useCliLoginStore.setState({
				statuses: { codex: { agent: "codex", state: "signed_in" } },
			});
			cliLoginActions.applyProfiles(withWork);
			expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();

			server.setStatuses([
				{ agent: "codex", profile_id: WORK, state: "signed_out" },
			]);
			cliLoginActions.applyProfiles(
				makeOverview({
					clis: [
						{ agent: "claude", profiles: [] },
						{
							agent: "codex",
							current_profile_id: WORK,
							profiles: [{ id: WORK, name: "Work" }],
						},
					],
				}),
			);

			await vi.waitFor(() =>
				expect(useCliLoginStore.getState().statuses.codex?.profile_id).toBe(
					WORK,
				),
			);
		});

		// While a sign-in runs, every profile of the CLI reads `signing_in`.
		it("inspects the profiles again when a sign-in it followed ends", async () => {
			useCliLoginStore.setState({
				inspections: {
					codex: {
						"": {
							status: {
								agent: "codex",
								state: "signing_in",
								login_id: "a",
								login_profile_id: WORK,
							},
						},
					},
				},
			});
			cliLoginActions.applyLogin(
				"codex",
				makeLogin({ id: "a", profile_id: WORK }),
			);
			server.setInspections([
				{ status: { agent: "codex", state: "signed_in" } },
			]);
			cliLoginActions.applyLogin(
				"codex",
				makeLogin({
					id: "a",
					profile_id: WORK,
					revision: 2,
					phase: "succeeded",
				}),
			);

			await vi.waitFor(() =>
				expect(inspections()?.[""]?.status.state).toBe("signed_in"),
			);
		});

		it("forgets a removed profile's inspection, and keeps it when refused", async () => {
			useCliLoginStore.setState({
				inspections: {
					codex: {
						[WORK]: {
							status: { agent: "codex", profile_id: WORK, state: "signed_in" },
						},
					},
				},
			});
			server.actions.cliProfileRemove.mockRejectedValueOnce(
				new JSONRPCErrorException("in use", -32014, { reason: "in_use" }),
			);
			await expect(
				cliLoginActions.removeProfile("codex", WORK),
			).rejects.toThrow("in use");
			expect(inspections()?.[WORK]).toBeDefined();

			await cliLoginActions.removeProfile("codex", WORK);
			expect(inspections()?.[WORK]).toBeUndefined();
		});

		// Only the profile signing in is; the others are waiting, and go on
		// showing what they read before.
		it("keeps a waiting profile's last result while another signs in", async () => {
			server.setInspections([
				{ status: { agent: "codex", profile_id: WORK, state: "signed_in" } },
			]);
			await cliLoginActions.inspectProfile("codex", WORK);
			server.setInspections([
				{
					status: {
						agent: "codex",
						profile_id: WORK,
						state: "signing_in",
						login_profile_id: "",
					},
				},
			]);
			await cliLoginActions.inspectProfile("codex", WORK);

			const s = useCliLoginStore.getState();
			expect(s.inspections.codex?.[WORK]?.status.state).toBe("signing_in");
			expect(s.settledInspections.codex?.[WORK]?.status.state).toBe(
				"signed_in",
			);
		});

		// An update that ended while nobody watched leaves `updating` behind.
		it("re-inspects a profile read while an update ran, once it ended", async () => {
			useCliLoginStore.setState({
				inspections: {
					codex: {
						[WORK]: {
							status: {
								agent: "codex",
								profile_id: WORK,
								state: "updating",
								update_id: "update-1",
							},
						},
					},
				},
			});
			server.setInspections([
				{ status: { agent: "codex", profile_id: WORK, state: "signed_in" } },
			]);
			cliLoginActions.applyUpdate(
				"codex",
				makeUpdate({ agent: "codex", phase: "succeeded" }),
			);

			await vi.waitFor(() =>
				expect(inspections()?.[WORK]?.status.state).toBe("signed_in"),
			);
		});

		it("does not let a read from before a switch land after it", async () => {
			let answerOld: (value: CliAuthStatus[]) => void = () => {};
			server.actions.cliAuthStatus.mockImplementationOnce(
				() =>
					new Promise<CliAuthStatus[]>((resolve) => {
						answerOld = resolve;
					}),
			);
			const old = cliLoginActions.refreshStatus("codex");
			server.setStatuses([
				{ agent: "codex", profile_id: WORK, state: "signed_out" },
			]);
			await cliLoginActions.switchProfile("codex", WORK);
			answerOld([{ agent: "codex", state: "signed_in" }]);
			await old;

			await vi.waitFor(() =>
				expect(useCliLoginStore.getState().statuses.codex?.profile_id).toBe(
					WORK,
				),
			);
		});

		// The server resends the list to every screen whenever one subscribes;
		// a copy that changes nothing must not spawn a CLI per screen.
		it("reads nothing again for a copy that changes nothing", () => {
			useCliLoginStore.setState({
				statuses: { codex: { agent: "codex", state: "signed_in" } },
				reading: { codex: true },
			});
			cliLoginActions.applyProfiles(withWork);
			cliLoginActions.applyProfiles(withWork);
			expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
		});

		// There every CLI runs as its default profile, whatever is chosen.
		it("takes the default profile as current where profiles cannot be used", () => {
			useCliLoginStore.setState({
				statuses: { codex: { agent: "codex", state: "signed_in" } },
			});
			cliLoginActions.applyProfiles({
				...withWork,
				available: false,
				clis: withWork.clis.map((c) => ({
					...c,
					current_profile_id: c.agent === "codex" ? WORK : undefined,
				})),
			});
			expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
		});

		it("forgets the inspections of profiles the list no longer has", () => {
			useCliLoginStore.setState({
				inspections: {
					codex: {
						"": { status: { agent: "codex", state: "signed_in" } },
						[WORK]: {
							status: { agent: "codex", profile_id: WORK, state: "signed_in" },
						},
					},
				},
			});
			cliLoginActions.applyProfiles(makeOverview());
			expect(Object.keys(inspections() ?? {})).toEqual([""]);
		});

		// A failed read says nothing of a profile; its missing `profile_id` is
		// not the default one's.
		it("does not take the default profile's sign-out over a failed read", async () => {
			cliLoginActions.applyProfiles(
				makeOverview({
					clis: [
						{ agent: "claude", profiles: [] },
						{
							agent: "codex",
							current_profile_id: WORK,
							profiles: [{ id: WORK, name: "Work" }],
						},
					],
				}),
			);
			server.actions.cliAuthStatus.mockRejectedValueOnce(
				new Error("timed out"),
			);
			await cliLoginActions.refreshStatus("codex");
			server.actions.cliAuthLogout.mockResolvedValueOnce({
				agent: "codex",
				state: "signed_out",
			});

			await cliLoginActions.logout("codex", "");

			expect(useCliLoginStore.getState().statuses.codex?.state).toBe(
				"unavailable",
			);
		});

		it("re-reads the current status after switching away from it", async () => {
			useCliLoginStore.setState({
				statuses: { codex: { agent: "codex", state: "signed_in" } },
			});
			await cliLoginActions.switchProfile("codex", WORK);
			expect(server.actions.cliProfileSwitch).toHaveBeenCalledWith(
				"codex",
				WORK,
			);
			expect(server.actions.cliAuthStatus).toHaveBeenCalledWith("codex");
		});
	});
});
