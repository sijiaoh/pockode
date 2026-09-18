import { JSONRPCErrorException } from "json-rpc-2.0";
import { describe, expect, it } from "vitest";
import { describeGitFailure, gitBusySummary } from "./gitErrors";

/** As the server writes it: server/rpc/types.go's CodeGitBusy and GitBusyData. */
function busy(operation: string): JSONRPCErrorException {
	return new JSONRPCErrorException(
		`another git operation is running in this worktree: ${operation}`,
		-32001,
		{ operation },
	);
}

describe("gitBusySummary", () => {
	it("says what the worktree is busy with", () => {
		expect(gitBusySummary(busy("pull"))).toBe(
			"This worktree is busy pulling. Try again once it finishes.",
		);
	});

	it("still explains a refusal that names an operation it does not know", () => {
		const summary = gitBusySummary(busy("rebase"));
		expect(summary).toContain("busy");
		expect(summary).not.toContain("rebase");
	});

	// The refusal is told apart by its code: git's own failures are prose the
	// panel must not try to read, and matching on English would break the moment
	// either side rewords a sentence.
	it("ignores a git failure that reads like one", () => {
		expect(
			gitBusySummary(
				new JSONRPCErrorException(
					"another git operation is running in this worktree",
					-32603,
				),
			),
		).toBeNull();
		expect(gitBusySummary(new Error("boom"))).toBeNull();
	});
});

describe("describeGitFailure", () => {
	it("quotes git and summarises it when git actually ran", () => {
		const failure = describeGitFailure(
			new JSONRPCErrorException("fatal: bad object", -32603),
			(detail) => `Failed: ${detail}`,
		);

		expect(failure).toEqual({
			summary: "Failed: fatal: bad object",
			detail: "fatal: bad object",
		});
	});

	// Nothing ran, so there is no git output — quoting the refusal under its own
	// paraphrase would be the panel talking to itself.
	it("leaves a refusal with no output to quote", () => {
		expect(describeGitFailure(busy("push"), () => "unused")).toEqual({
			summary: "This worktree is busy pushing. Try again once it finishes.",
			detail: null,
		});
	});
});
