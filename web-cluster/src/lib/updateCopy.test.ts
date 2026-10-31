import { describe, expect, it } from "vitest";
import { failureOutcome } from "./updateCopy";

const failed = (reason: string) =>
	Object.assign(new Error("boom"), { code: -32012, data: { reason } });

describe("failureOutcome", () => {
	// Backticks are code; a sentence standing in for a path is not.
	it("names the executable in words when its path is not known", () => {
		const ctx = { version: "0.25.0", path: null, check: null };
		const timeout = failureOutcome(failed("timeout"), ctx);
		expect(timeout).toMatchObject({ kind: "say" });
		if (timeout.kind !== "say") return;
		expect(timeout.body).toMatch(/ The cluster's executable is unchanged\.$/);
		expect(timeout.body).not.toContain("`");

		const restore = failureOutcome(failed("restore_failed"), ctx);
		if (restore.kind !== "say") throw new Error("expected copy");
		expect(restore.body).toContain("until the cluster's executable is back.");
	});
});
