import { describe, expect, it } from "vitest";
import { pushFailureSummary } from "./gitSyncMessages";

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
