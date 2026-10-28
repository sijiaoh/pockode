import { describe, expect, it } from "vitest";
import { makeBranch, makeBranches, makeHead } from "../test/gitFixtures";
import type { GitBranches, GitRemoteBranch } from "../types/git";
import {
	type BranchRow,
	branchDeleteUnavailableReason,
	branchDetails,
	branchMergeUnavailableReason,
	branchRowLabel,
	describeBranchDelete,
	describeMergePrompt,
	FILTER_THRESHOLD,
	groupBranches,
} from "./gitBranches";

const remote = (name: string): GitRemoteBranch => ({
	ref: `origin/${name}`,
	name,
	committed_at: new Date().toISOString(),
});

const titles = (b: GitBranches, filter = "") =>
	groupBranches(b, filter).map((g) => [g.title, g.rows.map((r) => r.label)]);

/** More branches than fit on screen, in the server's order. */
const LONG = makeBranches({
	local: [
		makeBranch("main", { current: true }),
		...Array.from({ length: FILTER_THRESHOLD }, (_, i) => makeBranch(`b${i}`)),
	],
	remote_only: [remote("colleague")],
	recent: ["main", "b5", "gone", "b2", "b7", "b1", "b0"],
});

describe("groupBranches", () => {
	// A list that fits on screen needs no grouping beyond Remote.
	it("keeps a short list as one headerless group in the server's order", () => {
		const b = makeBranches({
			local: [makeBranch("main", { current: true }), makeBranch("topic")],
			remote_only: [remote("colleague")],
			recent: ["main", "topic"],
		});

		expect(titles(b)).toEqual([
			[null, ["main", "topic"]],
			["Remote", ["origin/colleague"]],
		]);
	});

	it("puts the current branch and four recently checked out ones in Recent, each branch once", () => {
		expect(titles(LONG)).toEqual([
			["Recent", ["main", "b5", "b2", "b7", "b1"]],
			["Local", ["b0", "b3", "b4", "b6"]],
			["Remote", ["origin/colleague"]],
		]);
	});

	// Detached: no current row, and Recent is only what the reflog gives.
	it("has Recent hold only what recent gives when there is no current branch", () => {
		const detached = (recent: string[]): GitBranches => ({
			...LONG,
			head: makeHead({ branch: "", detached: true }),
			local: LONG.local.map((l) => ({ ...l, current: false })),
			recent,
		});

		expect(titles(detached(["b5", "main", "b2", "b7", "b1"]))[0]).toEqual([
			"Recent",
			["b5", "main", "b2", "b7"],
		]);
		expect(titles(detached([])).map(([t]) => t)).toEqual(["Local", "Remote"]);
	});

	// A branch never hops group while the filter is typed.
	it("filters within the groups and drops a group with no match", () => {
		expect(titles(LONG, " B2 ")).toEqual([["Recent", ["b2"]]]);
		expect(titles(LONG, "b3")).toEqual([["Local", ["b3"]]]);
		expect(titles(LONG, "nothing")).toEqual([]);
	});
});

const row = (overrides: Partial<BranchRow> = {}): BranchRow => ({
	key: "local:old-spike",
	label: "old-spike",
	name: "old-spike",
	current: false,
	remote: false,
	isDefault: false,
	committed_at: new Date().toISOString(),
	...overrides,
});

describe("branchDetails", () => {
	it("leads with one state word and leaves out counts that are 0", () => {
		expect(
			branchDetails(
				row({
					current: true,
					isDefault: true,
					vs_default: { ahead: 3, behind: 0 },
				}),
			),
		).toEqual(["current", "3 ahead"]);
		expect(
			branchDetails(
				row({ worktree: "review", vs_default: { ahead: 0, behind: 4 } }),
			),
		).toEqual(["in review", "4 behind"]);
		expect(branchDetails(row({ isDefault: true }))).toEqual(["default"]);
	});

	it("marks a remote row as the default when it is what counts are against", () => {
		const b = makeBranches({
			remote_only: [remote("main")],
			default_branch: "origin/main",
		});

		expect(branchDetails(groupBranches(b, "")[0].rows[0])).toEqual(["default"]);
	});
});

describe("branchRowLabel", () => {
	it("names the default branch once, on the first count", () => {
		expect(
			branchRowLabel(
				row({ vs_default: { ahead: 2, behind: 40 } }),
				"main",
				"3mo ago",
			),
		).toBe("old-spike, 2 ahead of main, 40 behind, last commit 3mo ago");
		expect(
			branchRowLabel(
				row({ worktree: "review", vs_default: { ahead: 0, behind: 4 } }),
				"main",
				"2d ago",
			),
		).toBe("old-spike, in review, 4 behind main, last commit 2d ago");
	});
});

describe("branchDeleteUnavailableReason", () => {
	const idle = { operation: null, switching: false, deleting: false };

	it("is available on an ordinary local branch", () => {
		expect(branchDeleteUnavailableReason(row(), idle)).toBeNull();
	});

	// The operation comes first: it is the one the user has to act on, and
	// it stops every row, occupied or not.
	it("gives the first reason that holds", () => {
		expect(
			branchDeleteUnavailableReason(row({ worktree: "review" }), {
				...idle,
				operation: "rebase",
				switching: true,
			}),
		).toBe("Finish or abort the rebase first.");
		expect(
			branchDeleteUnavailableReason(row({ worktree: "review" }), {
				...idle,
				switching: true,
			}),
		).toBe("Checked out in review.");
		expect(
			branchDeleteUnavailableReason(row(), { ...idle, switching: true }),
		).toBe("Wait for the branch switch to finish.");
	});
});

describe("branchMergeUnavailableReason", () => {
	const idle = {
		operation: null,
		switching: false,
		deleting: false,
		handingOff: false,
	};

	it("is available with a branch checked out", () => {
		expect(branchMergeUnavailableReason(makeHead(), idle)).toBeNull();
	});

	// A rebase detaches HEAD; switching to a branch is not the way out of it.
	it("gives the first reason that holds", () => {
		const detached = makeHead({ detached: true });
		expect(
			branchMergeUnavailableReason(detached, {
				...idle,
				operation: "rebase",
				switching: true,
			}),
		).toBe("Finish or abort the rebase first.");
		expect(
			branchMergeUnavailableReason(detached, { ...idle, switching: true }),
		).toBe("Switch to a branch to merge into.");
		expect(
			branchMergeUnavailableReason(makeHead(), {
				...idle,
				switching: true,
				deleting: true,
			}),
		).toBe("Wait for the branch switch to finish.");
		expect(
			branchMergeUnavailableReason(makeHead(), {
				...idle,
				deleting: true,
				handingOff: true,
			}),
		).toBe("Wait for the branch delete to finish.");
		expect(
			branchMergeUnavailableReason(makeHead(), { ...idle, handingOff: true }),
		).toBe("Wait for the new chat to open.");
	});
});

describe("describeMergePrompt", () => {
	const onTopic = (overrides: Partial<GitBranches> = {}) =>
		makeBranches({ head: makeHead({ branch: "feature/ui" }), ...overrides });
	const CONFLICTS =
		"If the merge stops on conflicts, resolve them keeping what both sides meant, then finish the merge. If a conflict cannot be resolved safely, stop and explain it instead of guessing.";

	it("names both branches and says what to do on conflicts", () => {
		expect(describeMergePrompt(row(), onTopic())).toBe(
			`Merge old-spike into feature/ui, the branch checked out in this worktree. ${CONFLICTS}`,
		);
	});

	it("names a remote row by its ref", () => {
		expect(
			describeMergePrompt(
				row({ label: "origin/colleague", name: "colleague", remote: true }),
				onTopic(),
			),
		).toMatch(/^Merge origin\/colleague into feature\/ui,/);
	});

	// Local main may be held by the main worktree, where nothing here can
	// bring it up to date.
	it("warns that a local default may be behind its remote, when there is one", () => {
		const main = row({ label: "main", name: "main", isDefault: true });
		expect(describeMergePrompt(main, onTopic())).toBe(
			`Merge main into feature/ui, the branch checked out in this worktree. If main tracks a remote branch that is ahead of it, fetch and merge that branch instead. ${CONFLICTS}`,
		);
		expect(
			describeMergePrompt(
				main,
				onTopic({ sync: { ...onTopic().sync, has_remote: false } }),
			),
		).not.toMatch(/fetch/);
		expect(
			describeMergePrompt(
				row({ label: "origin/main", remote: true, isDefault: true }),
				onTopic(),
			),
		).not.toMatch(/fetch/);
	});

	it("has nothing to merge into while HEAD is detached", () => {
		expect(
			describeMergePrompt(
				row(),
				makeBranches({ head: makeHead({ detached: true }) }),
			),
		).toBeNull();
	});
});

describe("describeBranchDelete", () => {
	const tip = "9692fc9d0b1e2a3c4d5e6f708192a3b4c5d6e7f8";

	it("asks plainly when nothing is lost, and says what stays on the remote", () => {
		expect(
			describeBranchDelete("old-spike", {
				tip,
				subject: "Try a new layout",
				unique: 0,
				upstream: "origin/old-spike",
			}),
		).toEqual({
			title: "Delete old-spike?",
			message:
				"Its commits are all on other branches, so nothing is lost. origin/old-spike stays on the remote.",
			confirmLabel: "Delete branch",
			variant: "default",
		});
	});

	// The button names the loss, and the latest commit is quoted so the work
	// can be recognised rather than trusted to a count.
	it("names the commits lost on a danger confirm", () => {
		expect(
			describeBranchDelete("old-spike", {
				tip,
				subject: "Try a new layout",
				unique: 2,
			}),
		).toEqual({
			title: "Delete old-spike and 2 commits?",
			message:
				'2 commits on old-spike are on no other branch and no remote, and will be lost. Latest: 9692fc9 "Try a new layout"',
			confirmLabel: "Delete 2 commits",
			variant: "danger",
		});
	});

	it("speaks of one commit in the singular", () => {
		const confirm = describeBranchDelete("x", {
			tip,
			subject: "s",
			unique: 1,
		});
		expect(confirm.title).toBe("Delete x and 1 commit?");
		expect(confirm.message).toMatch(/^1 commit on x is on no other branch/);
		expect(confirm.confirmLabel).toBe("Delete 1 commit");
	});
});
