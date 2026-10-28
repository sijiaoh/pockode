import { JSONRPCErrorException } from "json-rpc-2.0";
import { describe, expect, it } from "vitest";
import type { GitOperation } from "../types/git";
import {
	describeAbort,
	describeAbortFailure,
	describeOperation,
	describeOperationPrompt,
	findConflictRegions,
	hasConflictMarkers,
	type TextPart,
} from "./gitOperation";

const HASH = "9692fc9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const COMMIT = { hash: HASH, subject: "Add branch bar to git panel" };
const MAIN = {
	hash: "4be1f20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	subject: "Bump",
	ref: "main",
};

const MERGE: GitOperation = {
	kind: "merge",
	commit: { ...MAIN },
};
const REBASE: GitOperation = {
	kind: "rebase",
	commit: COMMIT,
	branch: "feature/git-ui",
	onto: MAIN,
	step: { current: 3, total: 7 },
};
const PICK: GitOperation = { kind: "cherry-pick", commit: COMMIT };
const REVERT: GitOperation = { kind: "revert", commit: COMMIT };

const text = (parts: TextPart[] | null) =>
	parts?.map((p) => p.text).join(" ") ?? null;

describe("describeOperation", () => {
	it.each([
		[MERGE, "Merge stopped on conflicts", "Merge not finished"],
		[REBASE, "Rebase stopped on conflicts", "Rebase paused"],
		[PICK, "Cherry-pick stopped on conflicts", "Cherry-pick not finished"],
		[REVERT, "Revert stopped on conflicts", "Revert not finished"],
	])("titles a %o by whether conflicts are left", (op, withConflicts, none) => {
		expect(describeOperation(op, 2, "feature/git-ui").title).toBe(
			withConflicts,
		);
		expect(describeOperation(op, 0, "feature/git-ui").title).toBe(none);
	});

	it("says what is combined with what, names in mono", () => {
		const merge = describeOperation(MERGE, 1, "feature/git-ui");
		expect(text(merge.context)).toBe("Merging main into feature/git-ui");
		expect(merge.context?.filter((p) => p.name).map((p) => p.text)).toEqual([
			"main",
			"feature/git-ui",
		]);
		expect(merge.commitLine).toBeNull();

		// The rebase's branch is its own, not the detached HEAD's.
		const rebase = describeOperation(REBASE, 1, null);
		expect(text(rebase.context)).toBe("Rebasing feature/git-ui onto main");
		expect(rebase.progress).toBe("3 of 7");
		expect(rebase.commitLine).toEqual({
			prefix: "At",
			hash: "9692fc9",
			subject: "Add branch bar to git panel",
		});

		expect(text(describeOperation(PICK, 1, "dev").context)).toBe(
			"Picking onto dev",
		);
		expect(describeOperation(PICK, 1, "dev").commitLine?.prefix).toBeNull();
		expect(text(describeOperation(REVERT, 1, "dev").context)).toBe(
			"Reverting on dev",
		);
	});

	// A part git could not tell is left out, never shown as a placeholder.
	it("leaves out what is not known", () => {
		expect(
			text(
				describeOperation(
					{ kind: "merge", commit: { hash: HASH, subject: "x" } },
					1,
					null,
				).context,
			),
		).toBe("Merging 9692fc9");
		expect(describeOperation(PICK, 1, null).context).toBeNull();
		expect(
			describeOperation({ kind: "cherry-pick" }, 1, "dev").commitLine,
		).toBeNull();

		const bare = describeOperation({ kind: "rebase" }, 0, null);
		expect(bare.context).toBeNull();
		expect(bare.progress).toBeNull();
		expect(bare.noConflictsLine).toBe(
			"No conflicts left. The rebase is paused.",
		);
	});

	it("says what is left once no conflict is", () => {
		const rebase = describeOperation(REBASE, 0, null);
		expect(rebase.noConflictsLine).toBe(
			"No conflicts left. The rebase is paused at step 3 of 7.",
		);
		expect(rebase.primaryLabel).toBe("Finish with agent");
		expect(describeOperation(MERGE, 0, "x").noConflictsLine).toBe(
			"No conflicts left. The merge still has to be finished.",
		);
		expect(describeOperation(MERGE, 1, "x").primaryLabel).toBe(
			"Resolve with agent",
		);
	});
});

describe("describeOperationPrompt", () => {
	it("names the operation and lists the conflicts in the list's order", () => {
		expect(
			describeOperationPrompt(
				REBASE,
				["web/src/components/Git/GitTab.tsx", "docs/git.md"],
				null,
			),
		).toBe(
			[
				'The repository is in the middle of a rebase of feature/git-ui onto main (step 3 of 7, replaying 9692fc9 "Add branch bar to git panel"), stopped on conflicts in:',
				"- docs/git.md",
				"- web/src/components/Git/GitTab.tsx",
				"",
				"Resolve these conflicts, keeping what both sides meant. Stage each file once it is resolved, then continue the rebase. If a conflict cannot be resolved safely, stop and explain it instead of guessing.",
			].join("\n"),
		);
	});

	it("asks only to finish when no conflict is left", () => {
		expect(describeOperationPrompt(MERGE, [], "feature/git-ui")).toBe(
			"The repository is in the middle of a merge of main into feature/git-ui. There are no conflicts left. Check the result, then finish the merge.",
		);
	});

	it("stays grammatical without the parts it does not know", () => {
		expect(describeOperationPrompt(MERGE, [], null)).toMatch(
			/^The repository is in the middle of a merge of main\. /,
		);
		expect(describeOperationPrompt({ kind: "cherry-pick" }, [], "dev")).toMatch(
			/^The repository is in the middle of a cherry-pick onto dev\. /,
		);
		expect(describeOperationPrompt(REVERT, [], "dev")).toMatch(
			/^The repository is in the middle of a revert of 9692fc9 "Add branch bar to git panel" on dev\. /,
		);
		expect(
			describeOperationPrompt({ kind: "rebase", branch: "x" }, [], null),
		).toMatch(/^The repository is in the middle of a rebase of x\. /);
	});

	it("caps the list at twenty paths", () => {
		const paths = Array.from(
			{ length: 34 },
			(_, i) => `f${String(i).padStart(2, "0")}`,
		);
		const lines = describeOperationPrompt(MERGE, paths, "x").split("\n");
		const listed = lines.filter((l) => l.startsWith("- "));
		expect(listed).toHaveLength(21);
		expect(listed[19]).toBe("- f19");
		expect(listed[20]).toBe("- … and 14 more (see git status)");
	});

	// A `git stash pop` leaves conflicts with nothing to continue.
	it("hands over conflicts with no operation in progress", () => {
		expect(describeOperationPrompt(undefined, ["a.txt"], "main")).toBe(
			[
				"The repository has unresolved conflicts in:",
				"- a.txt",
				"",
				"Resolve these conflicts, keeping what both sides meant. Stage each file once it is resolved. If a conflict cannot be resolved safely, stop and explain it instead of guessing.",
			].join("\n"),
		);
	});
});

describe("describeAbort", () => {
	it("says what goes back and what is lost, and names the verb", () => {
		expect(describeAbort(MERGE, 2, "feature/git-ui")).toEqual({
			title: "Abort the merge?",
			message:
				"feature/git-ui goes back to how it was before main was merged in. Conflicts resolved so far are lost and cannot be recovered.",
			confirmLabel: "Abort merge",
		});
		expect(describeAbort(REBASE, 2, null).message).toBe(
			"feature/git-ui goes back to how it was before the rebase. The 2 commits already replayed and any conflicts resolved so far are lost and cannot be recovered.",
		);
		expect(describeAbort(PICK, 1, "dev").message).toBe(
			"dev goes back to how it was before the cherry-pick began. Conflicts resolved so far are lost and cannot be recovered.",
		);
		expect(describeAbort(REVERT, 1, "dev").confirmLabel).toBe("Abort revert");
	});

	it("says the same loss for a state with no conflicts left", () => {
		expect(describeAbort(MERGE, 0, "x").message).toMatch(
			/The finished resolutions are lost and cannot be recovered\.$/,
		);
		expect(describeAbort(REBASE, 0, null).message).toMatch(
			/The 2 commits already replayed and the finished resolutions are lost/,
		);
	});

	it("counts replayed commits only when there are some", () => {
		const first = { ...REBASE, step: { current: 1, total: 7 } };
		expect(describeAbort(first, 1, null).message).toMatch(
			/before the rebase\. Conflicts resolved so far/,
		);
		const second = { ...REBASE, step: { current: 2, total: 7 } };
		expect(describeAbort(second, 1, null).message).toMatch(
			/The commit already replayed and any conflicts/,
		);
	});

	it("reads HEAD for a detached HEAD and drops an unknown clause", () => {
		expect(describeAbort({ kind: "merge" }, 1, null).message).toMatch(
			/^HEAD goes back to how it was before the merge\./,
		);
		// Between two commits of a sequence, git leaves the ones made since.
		expect(describeAbort({ kind: "cherry-pick" }, 1, "dev").message).toMatch(
			/^dev goes back to how it was before the cherry-pick, unless commits were made on it since/,
		);
	});
});

describe("describeAbortFailure", () => {
	const changed = (current: string) =>
		new JSONRPCErrorException("operation changed", -32005, { current });

	it("says which operation is in progress instead, and that nothing ran", () => {
		expect(describeAbortFailure(changed("merge"), "rebase")).toEqual({
			summary:
				"The rebase is no longer in progress — a merge is. Nothing was aborted.",
			detail: null,
		});
	});

	it("says nothing when the operation already ended", () => {
		expect(describeAbortFailure(changed(""), "rebase")).toBeNull();
	});

	it("quotes git when git failed, and explains a busy refusal", () => {
		expect(
			describeAbortFailure(
				new JSONRPCErrorException("error: boom", -32603),
				"merge",
			),
		).toEqual({ summary: "Could not abort the merge.", detail: "error: boom" });
		expect(
			describeAbortFailure(
				new JSONRPCErrorException("busy", -32001, { operation: "abort" }),
				"merge",
			),
		).toEqual({
			summary:
				"This worktree is busy aborting an operation. Try again once it finishes.",
			detail: null,
		});
	});
});

describe("findConflictRegions", () => {
	const text = (...lines: string[]) => lines.join("\n");

	it("finds each region's markers, the diff3 base included", () => {
		expect(
			findConflictRegions(
				text(
					"a",
					"<<<<<<< HEAD",
					"b",
					"||||||| base",
					"c",
					"=======",
					"d",
					">>>>>>> 9692fc9 (Add)",
					"<<<<<<< HEAD",
					"=======",
					">>>>>>> theirs",
				),
			),
		).toEqual([
			{ start: 1, base: 3, separator: 5, end: 7 },
			{ start: 8, separator: 9, end: 10 },
		]);
	});

	it("reads markers in a CRLF file", () => {
		expect(
			findConflictRegions("<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> t\r\n"),
		).toEqual([{ start: 0, separator: 2, end: 4 }]);
	});

	// Left plain: text between unpaired markers may be no conflict at all.
	it.each([
		["a close with no separator", text("<<<<<<< HEAD", "x", ">>>>>>> t")],
		["a separator with no open", text("x", "=======", ">>>>>>> t")],
		["an open never closed", text("<<<<<<< HEAD", "x", "=======", "y")],
		[
			"a second separator",
			text("<<<<<<< HEAD", "=======", "=======", ">>>>>>> t"),
		],
		[
			"markers of eight characters",
			text("<<<<<<<< x", "========", ">>>>>>>> x"),
		],
		[
			"a marker not at the line start",
			text(" <<<<<<< HEAD", "=======", ">>>>>>> t"),
		],
	])("counts nothing for %s", (_, input) => {
		expect(findConflictRegions(input)).toEqual([]);
	});

	it("drops an open marker opened again for the later one", () => {
		expect(
			findConflictRegions(
				text("<<<<<<< HEAD", "x", "<<<<<<< HEAD", "y", "=======", ">>>>>>> t"),
			),
		).toEqual([{ start: 2, separator: 4, end: 5 }]);
	});
});

describe("hasConflictMarkers", () => {
	it.each([
		["a paired region", "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> t\n", true],
		["an unpaired open", "x\n<<<<<<< HEAD\n", true],
		["a close alone", ">>>>>>> theirs", true],
		["a longer marker size", "<<<<<<<<<< HEAD\n", true],
		["a bare open marker", "<<<<<<<\r\n", true],
		["a diff3 base left behind", "a\n||||||| base\nold\n=======\nb\n", true],
		["a setext heading", "Title\n=======\n", false],
		["a marker not at the line start", "  <<<<<<< HEAD", false],
		["arrows in text", "a <<<<<<< b", false],
	])("%s", (_, text, expected) => {
		expect(hasConflictMarkers(text)).toBe(expected);
	});
});
