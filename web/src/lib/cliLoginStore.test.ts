import { JSONRPCErrorException } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
	makeUpdate,
	resetCliLoginStore,
} from "../test/cliAuthFixtures";
import type { CliAuthStatus } from "../types/cliAuth";
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
				new JSONRPCErrorException("npm is not on the PATH", -32003, {
					reason: "npm_not_found",
				}),
			);

			await expect(cliLoginActions.startInstall("claude")).rejects.toThrow();

			expect(server.actions.cliUpdateCheck).not.toHaveBeenCalled();
			expect(server.actions.cliAuthStatus).not.toHaveBeenCalled();
		});
	});
});
