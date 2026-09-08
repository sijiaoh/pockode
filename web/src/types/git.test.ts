import { describe, expect, it } from "vitest";
import { makeSync } from "../test/gitFixtures";
import type { FileStatus, GitStatus, GitSync, GitSyncState } from "./git";
import {
	describeCommitAction,
	describeDiscard,
	describeGitSync,
	stagedSubmodules,
} from "./git";

describe("describeGitSync", () => {
	const cases: {
		name: string;
		sync: Partial<GitSync>;
		want: GitSyncState;
	}[] = [
		{
			// Pulling stays available with nothing known to pull: behind is only as
			// fresh as the last fetch, and the pull fetches first.
			name: "up to date",
			sync: {},
			want: {
				needsPublish: false,
				diverged: false,
				canPull: true,
				canPush: false,
			},
		},
		{
			// The regression this rule exists for: a worktree that has never
			// fetched reads as 0 behind, which used to disable pull outright.
			name: "never fetched",
			sync: { last_fetch: null },
			want: {
				needsPublish: false,
				diverged: false,
				canPull: true,
				canPush: false,
			},
		},
		{
			name: "behind only",
			sync: { behind: 2 },
			want: {
				needsPublish: false,
				diverged: false,
				canPull: true,
				canPush: false,
			},
		},
		{
			name: "ahead only",
			sync: { ahead: 1 },
			want: {
				needsPublish: false,
				diverged: false,
				canPull: true,
				canPush: true,
			},
		},
		{
			name: "diverged",
			sync: { ahead: 1, behind: 2 },
			want: {
				needsPublish: false,
				diverged: true,
				canPull: true,
				canPush: true,
			},
		},
		{
			// Nothing to compare against, so pulling is meaningless and pushing is
			// what creates the upstream.
			name: "no upstream",
			sync: { upstream: "" },
			want: {
				needsPublish: true,
				diverged: false,
				canPull: false,
				canPush: true,
			},
		},
		{
			// The counts are unknown rather than zero here, so this must not read
			// as "in sync" however the numbers happen to look.
			name: "upstream configured but missing locally",
			sync: { upstream_gone: true, ahead: 3, behind: 4 },
			want: {
				needsPublish: true,
				diverged: false,
				canPull: false,
				canPush: true,
			},
		},
		{
			// The chip is hidden without a remote, but the function is exported and
			// has to be right anyway: there is nowhere to publish to.
			name: "no remote at all",
			sync: { has_remote: false, upstream: "" },
			want: {
				needsPublish: true,
				diverged: false,
				canPull: false,
				canPush: false,
			},
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(describeGitSync(makeSync(c.sync))).toEqual(c.want);
		});
	}
});

describe("describeCommitAction", () => {
	const status = (staged: string[], unstaged: string[]): GitStatus => ({
		staged: staged.map((path) => ({ path, status: "M" as const })),
		unstaged: unstaged.map((path) => ({ path, status: "M" as const })),
	});

	it("offers the staged count", () => {
		expect(describeCommitAction(status(["a.ts", "b.ts"], []))).toEqual({
			label: "Commit (2)",
			enabled: true,
			hint: null,
		});
	});

	// The user is on their way to committing: a target that only appears once the
	// first file is staged is worse than one that is visibly not ready yet.
	it("keeps a disabled button while there is something to stage", () => {
		expect(describeCommitAction(status([], ["a.ts"]))).toEqual({
			label: "Commit",
			enabled: false,
			// The stage buttons it names are on screen right above the bar, so it
			// is worth saying to a screen reader and not worth a line of text.
			hint: { text: "Stage a file to commit", alreadyOnScreen: true },
		});
	});

	// The file groups above the bar list submodule files too, so a bar that
	// vanishes there would leave staged rows on screen with no commit button and
	// no account of why.
	it("explains itself when only a submodule has something staged", () => {
		expect(
			describeCommitAction({
				...status([], []),
				submodules: { "vendor/sdk": status(["sub.ts"], []) },
			}),
		).toEqual({
			label: "Commit",
			enabled: false,
			// Nothing else on the panel accounts for this one: the rows read as
			// staged like any other, so the bar has to spend a line saying it.
			hint: {
				text: "Only submodule files are staged; ask the agent in chat to commit them.",
				alreadyOnScreen: false,
			},
		});
	});

	it("counts a submodule's unstaged files as something to stage", () => {
		expect(
			describeCommitAction({
				...status([], []),
				submodules: { "vendor/sdk": status([], ["sub.ts"]) },
			}),
		).toMatchObject({
			enabled: false,
			hint: { text: "Stage a file to commit" },
		});
	});

	// Nothing to commit and nothing on its way to being committed: the bar itself
	// is what goes away, not just its button.
	it("renders no bar on a clean tree", () => {
		expect(describeCommitAction(status([], []))).toBeNull();
	});

	// An unreadable status is not an empty one, and the panel is already showing
	// why it could not be read.
	it("renders no bar without a status", () => {
		expect(describeCommitAction(undefined)).toBeNull();
	});
});

describe("stagedSubmodules", () => {
	it("counts only submodules with something staged", () => {
		expect(
			stagedSubmodules({
				staged: [{ path: "root.ts", status: "M" }],
				unstaged: [],
				submodules: {
					"vendor/sdk": {
						staged: [
							{ path: "a.ts", status: "M" },
							{ path: "b.ts", status: "A" },
						],
						unstaged: [],
					},
					docs: { staged: [], unstaged: [{ path: "c.md", status: "M" }] },
				},
			}),
		).toEqual([{ path: "vendor/sdk", count: 2 }]);
	});

	it("is empty when nothing is staged in a submodule", () => {
		expect(
			stagedSubmodules({
				staged: [{ path: "root.ts", status: "M" }],
				unstaged: [],
			}),
		).toEqual([]);
	});
});

describe("describeDiscard", () => {
	const modified = (path: string): FileStatus => ({ path, status: "M" });
	const untracked = (path: string): FileStatus => ({ path, status: "?" });

	const cases: {
		name: string;
		files: FileStatus[];
		title: string;
		message: string;
		confirmLabel: string;
		failureSummary: string;
	}[] = [
		{
			name: "a single tracked file loses its edits",
			files: [modified("src/foo.ts")],
			title: "Discard changes?",
			message: "Your edits to src/foo.ts will be lost. This cannot be undone.",
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		},
		{
			// A different outcome deserves different words: nothing is restored
			// here, the file stops existing.
			name: "a single untracked file is deleted",
			files: [untracked("notes.txt")],
			title: "Delete file?",
			message:
				"notes.txt is not tracked by git and will be permanently deleted. This cannot be undone.",
			confirmLabel: "Delete",
			failureSummary: "Delete failed.",
		},
		{
			name: "a mixed selection describes both halves",
			files: [
				modified("a.ts"),
				modified("b.ts"),
				modified("c.ts"),
				untracked("notes.txt"),
			],
			title: "Discard all changes?",
			message:
				"3 files will lose their edits and 1 untracked file will be deleted. This cannot be undone.",
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		},
		{
			name: "several tracked files",
			files: [modified("a.ts"), modified("b.ts")],
			title: "Discard all changes?",
			message: "2 files will lose their edits. This cannot be undone.",
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		},
		{
			// Nothing is discarded here, so the wording says what it does.
			name: "several untracked files",
			files: [untracked("a.txt"), untracked("b.txt")],
			title: "Delete all files?",
			message:
				"2 untracked files will be permanently deleted. This cannot be undone.",
			confirmLabel: "Delete",
			failureSummary: "Delete failed.",
		},
		{
			// The group header sends a batch of one whenever a single file is
			// unstaged, and naming it beats counting it.
			name: "a batch of one is still named",
			files: [modified("only.ts")],
			title: "Discard changes?",
			message: "Your edits to only.ts will be lost. This cannot be undone.",
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		},
		{
			name: "one tracked and one untracked agree in number",
			files: [modified("a.ts"), untracked("b.txt")],
			title: "Discard all changes?",
			message:
				"1 file will lose its edits and 1 untracked file will be deleted. This cannot be undone.",
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		},
		{
			// Deletions and renames are edits to a tracked file, not deletions of
			// an untracked one.
			name: "a deleted tracked file is not treated as untracked",
			files: [{ path: "gone.ts", status: "D" }],
			title: "Discard changes?",
			message: "Your edits to gone.ts will be lost. This cannot be undone.",
			confirmLabel: "Discard",
			failureSummary: "Discard failed.",
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(describeDiscard(c.files)).toEqual({
				title: c.title,
				message: c.message,
				confirmLabel: c.confirmLabel,
				failureSummary: c.failureSummary,
			});
		});
	}
});
