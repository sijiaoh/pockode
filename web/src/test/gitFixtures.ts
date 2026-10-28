import type { GitBranch, GitBranches, GitHead, GitSync } from "../types/git";

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
