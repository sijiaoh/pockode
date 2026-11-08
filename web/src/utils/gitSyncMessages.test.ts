import { describe, expect, it } from "vitest";
import { makeSync } from "../test/gitFixtures";
import { commitPushBlocker, pushFailureSummary } from "./gitSyncMessages";

// Both rejections mean "the remote moved", but only one of them can be answered
// by pulling — so they must not collapse into the same advice.
describe("pushFailureSummary", () => {
	it("tells a stale lease apart from a remote that is simply ahead", () => {
		expect(
			pushFailureSummary("stale info: remote ref updated since checkout"),
		).toMatch(/Fetch, then try again/);
		expect(
			pushFailureSummary("! [rejected] main -> main (fetch first)"),
		).toMatch(/pull or force push/);
	});

	// git's own message is shown below the summary either way, so a guess here
	// would only be a wrong guess.
	it("guesses nothing about a rejection it does not recognise", () => {
		expect(pushFailureSummary("Permission denied (publickey).")).toBe(
			"Push failed.",
		);
	});
});

describe("commitPushBlocker", () => {
	const SYNC = makeSync();

	it("lets a plain push follow a branch that is not behind", () => {
		expect(commitPushBlocker({ ...SYNC, ahead: 3 }, null)).toBeNull();
	});

	// One more commit would leave the branch diverged, and that push is a force
	// push.
	it("refuses a branch behind its upstream, saying how far", () => {
		expect(commitPushBlocker({ ...SYNC, behind: 2 }, null)).toBe(
			"origin/main has 2 commits this branch does not — pull before pushing.",
		);
	});

	// The counts of a gone upstream are unknown, and publishing recreates it.
	it("ignores the counts of a branch that still needs publishing", () => {
		expect(
			commitPushBlocker({ ...SYNC, upstream_gone: true, behind: 2 }, null),
		).toBeNull();
	});

	it("waits out a sync already running in the worktree", () => {
		expect(commitPushBlocker(SYNC, "fetch")).toBe(
			"Waiting for the fetch to finish.",
		);
	});
});
