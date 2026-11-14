import { JSONRPCErrorException } from "json-rpc-2.0";
import { describe, expect, it, vi } from "vitest";
import { createCliAuthActions } from "./cliAuth";
import { cliProfileRemoveRefusal, createCliProfileActions } from "./cliProfile";

describe("cliProfileRemoveRefusal", () => {
	it("reads the reason and the sessions in the way", () => {
		const error = new JSONRPCErrorException("2 sessions are mid-turn", -32014, {
			reason: "in_use",
			sessions: [{ session_id: "s1" }, { worktree: "feat", session_id: "s2" }],
		});
		expect(cliProfileRemoveRefusal(error)).toEqual({
			reason: "in_use",
			sessions: [{ session_id: "s1" }, { worktree: "feat", session_id: "s2" }],
			message: "2 sessions are mid-turn",
		});
	});

	it("is null for any other failure", () => {
		expect(cliProfileRemoveRefusal(new Error("timed out"))).toBeNull();
		expect(
			cliProfileRemoveRefusal(
				new JSONRPCErrorException("bad", -32602, { reason: "in_use" }),
			),
		).toBeNull();
		expect(
			cliProfileRemoveRefusal(
				new JSONRPCErrorException("new", -32014, { reason: "unheard_of" }),
			),
		).toBeNull();
	});
});

// Absent is the current profile and "" the default one: dropping "" as falsy
// would sign the wrong account out.
describe("profile_id", () => {
	function requester() {
		const request = vi.fn(async () => ({
			statuses: [],
			status: {},
			profiles: [],
		}));
		return { request, get: () => ({ request }) as never };
	}

	it("sends the default profile's empty id and leaves out an absent one", async () => {
		const short = requester();
		const long = requester();
		const auth = createCliAuthActions(short.get, long.get);
		const profiles = createCliProfileActions(short.get, long.get);

		await auth.cliAuthLogout("claude", "");
		await auth.cliAuthLogout("claude");
		await profiles.cliProfileInspect("claude", "");
		await profiles.cliProfileRemove("claude", "p1");

		expect(long.request.mock.calls).toEqual([
			["cli_auth.logout", { agent: "claude", profile_id: "" }],
			["cli_auth.logout", { agent: "claude" }],
			["cli_profile.inspect", { agent: "claude", profile_id: "" }],
			["cli_profile.remove", { agent: "claude", profile_id: "p1" }],
		]);
		expect(short.request).not.toHaveBeenCalled();
	});
});
