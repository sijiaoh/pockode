import { describe, expect, it } from "vitest";
import type { SyncRun } from "../lib/gitSyncStore";
import { makeHead, makeSync } from "../test/gitFixtures";
import type { GitBranches, GitSync } from "../types/git";
import {
	AUTO_FETCH_AFTER_MS,
	describeSyncStatus,
	shouldAutoFetch,
} from "./gitSyncStatus";

const IDLE: SyncRun = { running: null, outcome: null, auto: false };

const step = (sync: Partial<GitSync>) =>
	describeSyncStatus(makeSync(sync), IDLE).step.kind;

describe("describeSyncStatus", () => {
	it.each([
		// Publishing outranks counts: behind an unpublished branch they mean nothing.
		[{ upstream: "", ahead: 3, behind: 2 }, "publish"],
		[{ upstream_gone: true }, "publish"],
		[{ ahead: 1, behind: 2 }, "diverged"],
		[{ behind: 2 }, "pull"],
		[{ ahead: 1 }, "push"],
		// Zero counts no fetch ever produced must not read as "up to date".
		[{ last_fetch: null }, "unfetched"],
		[{}, "synced"],
	] as const)("names the first step that holds for %o", (sync, kind) => {
		expect(step(sync)).toBe(kind);
	});

	it("puts a run in flight ahead of the step without replacing it", () => {
		const status = describeSyncStatus(makeSync({ behind: 2 }), {
			...IDLE,
			running: "fetch",
			auto: true,
		});

		expect(status.step).toEqual({ kind: "pull", behind: 2 });
		expect(status.description).toBe("fetching…");
	});

	it("flags an automatic fetch that failed, and only an automatic one", () => {
		const outcome = { kind: "error", summary: "s", detail: null } as const;

		expect(
			describeSyncStatus(makeSync(), { ...IDLE, outcome, auto: true }),
		).toMatchObject({
			autoFetchFailed: true,
			description: "up to date, automatic fetch failed",
		});
		expect(
			describeSyncStatus(makeSync(), { ...IDLE, outcome }).autoFetchFailed,
		).toBe(false);
	});
});

describe("shouldAutoFetch", () => {
	const NOW = Date.parse("2026-10-27T12:00:00Z");
	const fetchedAgo = (ms: number) => new Date(NOW - ms).toISOString();

	function branches(sync: Partial<GitSync>, detached = false): GitBranches {
		return {
			head: makeHead({ detached }),
			local: [],
			remote_only: [],
			sync: makeSync(sync),
		};
	}

	it("fetches when the last fetch is more than ten minutes old", () => {
		const stale = branches({ last_fetch: fetchedAgo(AUTO_FETCH_AFTER_MS + 1) });
		const fresh = branches({ last_fetch: fetchedAgo(AUTO_FETCH_AFTER_MS) });

		expect(shouldAutoFetch(stale, null, NOW)).toBe(true);
		expect(shouldAutoFetch(fresh, null, NOW)).toBe(false);
	});

	it("fetches a worktree that has never fetched", () => {
		expect(shouldAutoFetch(branches({ last_fetch: null }), null, NOW)).toBe(
			true,
		);
	});

	it("leaves a worktree alone while a sync is already running", () => {
		expect(shouldAutoFetch(branches({ last_fetch: null }), "push", NOW)).toBe(
			false,
		);
	});

	// No chip, nowhere to report a failure: running would risk a silent one.
	it("does not fetch where the chip is not shown", () => {
		expect(
			shouldAutoFetch(branches({ last_fetch: null }, true), null, NOW),
		).toBe(false);
		expect(
			shouldAutoFetch(
				branches({ last_fetch: null, has_remote: false }),
				null,
				NOW,
			),
		).toBe(false);
	});
});
