import { describe, expect, it } from "vitest";
import { makeSync } from "../test/gitFixtures";
import type { FileStatus, GitSync, GitSyncState } from "./git";
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
			name: "up to date",
			sync: {},
			want: {
				needsPublish: false,
				diverged: false,
				canPull: false,
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
				canPull: false,
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
	const cases: {
		name: string;
		staged: number | null;
		hasCommits: boolean;
		label: string;
		enabled: boolean;
		amend: boolean;
	}[] = [
		{
			name: "staged files",
			staged: 2,
			hasCommits: true,
			label: "Commit (2)",
			enabled: true,
			amend: false,
		},
		{
			name: "nothing staged, with history",
			staged: 0,
			hasCommits: true,
			label: "Amend last commit",
			enabled: true,
			amend: true,
		},
		{
			name: "nothing staged, no commits yet",
			staged: 0,
			hasCommits: false,
			label: "Commit",
			enabled: false,
			amend: false,
		},
		{
			// An unreadable status is not an empty one: offering to amend here
			// would be a guess about a repository nothing is known about.
			name: "status unavailable",
			staged: null,
			hasCommits: true,
			label: "Commit",
			enabled: false,
			amend: false,
		},
		{
			// The first commit of a repository, which has nothing to amend.
			name: "staged files, no commits yet",
			staged: 1,
			hasCommits: false,
			label: "Commit (1)",
			enabled: true,
			amend: false,
		},
	];

	for (const c of cases) {
		it(c.name, () => {
			expect(describeCommitAction(c.staged, c.hasCommits)).toEqual({
				label: c.label,
				enabled: c.enabled,
				amend: c.amend,
			});
		});
	}
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
