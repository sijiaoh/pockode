import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFakeCliAuth,
	type FakeCliAuth,
	makeLogin,
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
});
