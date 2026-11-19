import type { JSONRPCRequester } from "json-rpc-2.0";
import { describe, expect, it } from "vitest";
import { TYPE_CHANGE_DIFF } from "../../test/gitFixtures";
import { createGitActions } from "./git";

describe("getCommitDiff", () => {
	// The viewer reads one file's patch and throws on a second section.
	it("hands on a type change as one file's patch", async () => {
		const client: JSONRPCRequester<void> = {
			request: async () => TYPE_CHANGE_DIFF,
		} as unknown as JSONRPCRequester<void>;
		const git = createGitActions(
			() => client,
			() => client,
		);

		const data = await git.getCommitDiff("abc", "a.txt");

		expect(data.diff.match(/^diff --git /gm)).toHaveLength(1);
	});
});
