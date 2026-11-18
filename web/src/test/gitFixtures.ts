import type {
	GitBranch,
	GitBranches,
	GitDiffData,
	GitHead,
	GitRemoteBranch,
	GitSync,
} from "../types/git";

/**
 * A branch in sync with its upstream, the state every other one is a deviation
 * from. Tests override only the fields their case is about.
 */
export function makeSync(overrides: Partial<GitSync> = {}): GitSync {
	return {
		has_remote: true,
		upstream: "origin/main",
		upstream_gone: false,
		ahead: 0,
		behind: 0,
		head_pushed: true,
		last_fetch: new Date().toISOString(),
		...overrides,
	};
}

/** An attached HEAD with one commit behind it. */
export function makeHead(overrides: Partial<GitHead> = {}): GitHead {
	return {
		branch: "main",
		hash: "abc1234",
		detached: false,
		message: "Add branch bar to git panel",
		...overrides,
	};
}

/** A local branch nobody else holds, with nothing to say against main. */
export function makeBranch(
	name: string,
	overrides: Partial<GitBranch> = {},
): GitBranch {
	return {
		name,
		current: false,
		committed_at: new Date().toISOString(),
		committer: "Test",
		...overrides,
	};
}

/** `origin/<name>`, with no local branch of that name. */
export function makeRemoteBranch(
	name: string,
	overrides: Partial<GitRemoteBranch> = {},
): GitRemoteBranch {
	return {
		ref: `origin/${name}`,
		name,
		committed_at: new Date().toISOString(),
		committer: "Test",
		...overrides,
	};
}

/** No branches listed beyond HEAD, in sync with its upstream. */
export function makeBranches(
	overrides: Partial<GitBranches> = {},
): GitBranches {
	return {
		head: makeHead(),
		local: [],
		remote_only: [],
		sync: makeSync(),
		default_branch: "main",
		recent: [],
		...overrides,
	};
}
/**
 * `git diff a.txt` after `rm a.txt && ln -s real.txt a.txt`, as git 2.x writes
 * it: one path, two sections. The server passes it through as is.
 */
export const TYPE_CHANGE_DIFF: GitDiffData = {
	diff: [
		"diff --git a/a.txt b/a.txt",
		"deleted file mode 100644",
		"index d95f3ad..0000000",
		"--- a/a.txt",
		"+++ /dev/null",
		"@@ -1 +0,0 @@",
		"-content",
		"diff --git a/a.txt b/a.txt",
		"new file mode 120000",
		"index 0000000..c9c61fe",
		"--- /dev/null",
		"+++ b/a.txt",
		"@@ -0,0 +1 @@",
		"+real.txt",
		"\\ No newline at end of file",
		"",
	].join("\n"),
	old_content: "content\n",
	new_content: "real.txt",
};
