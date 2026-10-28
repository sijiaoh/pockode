import { create } from "zustand";
import type { GitFailure } from "../utils/gitErrors";
import { worktreeActions } from "./worktreeStore";

/**
 * Which pending set a write shows up in. Stage and unstage share one: both
 * leave the row's other button with a stale idea of the file, so a row is busy
 * for either.
 */
export type GitWriteKind = "toggle" | "discard";

export interface GitWrites {
	/** Paths with a stage or unstage queued or running. */
	toggling: Set<string>;
	/** Paths with a discard queued or running. */
	discarding: Set<string>;
	/**
	 * Hunk IDs with a stage or unstage queued or running, by path. A set of
	 * their own because a path holds many hunks: keyed by path alone, a second
	 * hunk's press would be dropped as a duplicate of the first.
	 */
	hunks: Map<string, Set<string>>;
}

/** A stage, unstage or discard from the Changes list that the user has not put away. */
export interface GitWriteFailure extends GitFailure {
	/** What failed, so only a retry of it can clear the failure. */
	paths: string[];
}

interface GitWriteState {
	/** Keyed by worktree name, the same key the rest of the workspace switches on. */
	writes: Record<string, GitWrites>;
	/**
	 * The Changes list's banner, per worktree. Here rather than in the list for
	 * the reason the pending sets are: the write outlives the list. Leaving the
	 * segment or the workspace unmounts the list, and a failure that settles
	 * meanwhile — or that the user had not dismissed yet — would be gone when
	 * they come back, which is a failure nobody was told about. Per worktree
	 * because the paths it names are that worktree's.
	 */
	failures: Record<string, GitWriteFailure>;
}

/**
 * The panel's fast local writes — stage, unstage, discard — run one at a time
 * per worktree, and this is where they queue.
 *
 * Without it, tapping two files' stage buttons in a row is two `git.add`
 * requests overlapping in one worktree: each row only disables *itself* while
 * its request is in flight, and react-query does not serialise mutations. All
 * three of these writes take the server's index lock for the worktree
 * (docs/git.md#serialising-writes) — a fetch would not stand in their way, but
 * each other they do — so the second would come back refused, an error the user
 * never did anything to deserve. Queueing is the right shape rather than
 * dropping, unlike the sync store's guard: the second tap names a different
 * file, so it is a second thing the user asked for and not a duplicate of the
 * first.
 *
 * It holds only the writes that finish on this machine in one round trip.
 * Commit runs hooks and fetch/pull/push wait on another machine, so queueing
 * behind one of those would turn a tap into a hang with nothing on screen to
 * explain it — those collide rarely (each is behind its own single control) and
 * the server's refusal, in plain language, is the answer when they do.
 *
 * A slot is longer than the git command in it: stage and unstage invalidate
 * `git-status` from `onSuccess`, which react-query awaits before `mutateAsync`
 * resolves, so the next one starts only once the list has the moved row. That
 * is what keeps a row's spinner up until it is in the group it belongs to,
 * instead of clearing in the old one and jumping a moment later.
 *
 * It lives outside the workspace's components because a write has to outlive
 * the one that started it: staging from an open diff and navigating away
 * unmounts that view mid-request, and leaving the Git workspace unmounts the
 * lists — which is where the old per-component sets lost track of what was
 * still running. Keyed by worktree for the reason
 * gitSyncStore is: switching mid-write is reachable, and one record would let
 * A's pending paths grey out B's rows.
 */
export const useGitWriteStore = create<GitWriteState>(() => ({
	writes: {},
	failures: {},
}));

/**
 * A queued write that was dropped because the user left the worktree it was
 * queued for.
 *
 * A git write names no worktree of its own: the server applies it to whichever
 * one this connection is bound to, and `worktree.switch` rebinds it. An
 * unstarted write therefore stops meaning what it meant when it was tapped —
 * it would stage or discard a same-named path in the tree the user has just
 * moved to. Sending it immediately was what used to make that impossible, since
 * one connection answers in order; a queue is what gives the switch room to
 * land in between, so the queue is what has to check. uploadStore cancels a
 * queued upload on the same reasoning.
 */
export class WorktreeChangedError extends Error {
	constructor() {
		super("Cancelled — worktree changed");
		this.name = "WorktreeChangedError";
	}
}

/** A worktree nothing has been written in, as a stable identity for selectors. */
const IDLE: GitWrites = {
	toggling: new Set(),
	discarding: new Set(),
	hunks: new Map(),
};

/**
 * Whether any write — of the whole file or of one of its hunks — is pending
 * on the path. Each of them leaves the others with a stale idea of the file,
 * so every control writing it waits for all of them.
 */
export function isPathWriting(writes: GitWrites, path: string): boolean {
	return (
		writes.toggling.has(path) ||
		writes.discarding.has(path) ||
		writes.hunks.has(path)
	);
}

/**
 * The tail of each worktree's queue. Outside the store because nothing renders
 * from it, and the promise identity must not be what components re-render on.
 */
const queues = new Map<string, Promise<void>>();

function writesOf(worktree: string): GitWrites {
	return useGitWriteStore.getState().writes[worktree] ?? IDLE;
}

function setPending(
	worktree: string,
	kind: GitWriteKind,
	paths: string[],
	pending: boolean,
) {
	useGitWriteStore.setState((s) => {
		const current = s.writes[worktree] ?? IDLE;
		const key = kind === "toggle" ? "toggling" : "discarding";
		const next = new Set(current[key]);
		for (const path of paths) {
			if (pending) next.add(path);
			else next.delete(path);
		}
		return { writes: { ...s.writes, [worktree]: { ...current, [key]: next } } };
	});
}

function setHunkPending(
	worktree: string,
	path: string,
	hunkId: string,
	pending: boolean,
) {
	useGitWriteStore.setState((s) => {
		const current = s.writes[worktree] ?? IDLE;
		const hunks = new Map(current.hunks);
		const ids = new Set(hunks.get(path));
		if (pending) ids.add(hunkId);
		else ids.delete(hunkId);
		if (ids.size > 0) hunks.set(path, ids);
		else hunks.delete(path);
		return { writes: { ...s.writes, [worktree]: { ...current, hunks } } };
	});
}

/**
 * Runs `action` once everything already queued for the worktree has settled,
 * and `release` after it either way.
 */
function enqueue(
	worktree: string,
	action: () => Promise<unknown>,
	release: () => void,
): Promise<void> {
	const previous = queues.get(worktree) ?? Promise.resolve();
	// Released inside the chain rather than after it, so that a caller which
	// has seen this settle is looking at rows that are no longer pending.
	const settled = previous.then(async () => {
		try {
			// Checked here rather than when the write was queued: this is the
			// moment the request is actually sent, and the only one at which
			// the worktree it will reach is known.
			if (worktreeActions.getCurrent() !== worktree) {
				throw new WorktreeChangedError();
			}
			await action();
		} finally {
			release();
		}
	});
	// What the next caller waits on, with the outcome swallowed: the queue
	// only tracks "is anything still running here".
	const tail = settled.then(
		() => {},
		() => {},
	);
	queues.set(worktree, tail);
	void tail.then(() => {
		// Only if nothing has queued behind it, or this would drop a live queue.
		if (queues.get(worktree) === tail) queues.delete(worktree);
	});

	return settled;
}

export const gitWriteActions = {
	/**
	 * Queues one write behind whatever this worktree is already writing.
	 *
	 * Rejects with the request's own error, so the caller reports its own
	 * failure; a failure never stops what is queued behind it, which belongs to
	 * a tap the user made separately. A write whose turn comes after the user
	 * has left the worktree is not sent at all and rejects with
	 * WorktreeChangedError, which the workspace drops rather than reports:
	 * nothing was written, so there is nothing to tell.
	 *
	 * Paths that already have a write of the whole file pending are left out:
	 * that request is doing this one's job, and the pending sets count a path
	 * once. A pending hunk write does not drop the path — this one simply
	 * queues behind it — though every control that starts one waits for it. A call left
	 * with nothing at all to do resolves as if it had succeeded, which it can
	 * afford to because every control that could raise one is disabled while the
	 * write it would duplicate is pending — and because the request that *is*
	 * doing the work reports its own outcome either way.
	 *
	 * @param action runs the request for the paths that were accepted.
	 */
	run: (
		worktree: string,
		kind: GitWriteKind,
		requested: string[],
		action: (paths: string[]) => Promise<unknown>,
	): Promise<void> => {
		const { toggling, discarding } = writesOf(worktree);
		const paths = requested.filter(
			(path) => !toggling.has(path) && !discarding.has(path),
		);
		if (paths.length === 0) return Promise.resolve();

		setPending(worktree, kind, paths, true);
		return enqueue(
			worktree,
			() => action(paths),
			() => setPending(worktree, kind, paths, false),
		);
	},

	/**
	 * Queues the stage or unstage of one hunk, as `run` queues a file's.
	 *
	 * Dropped, resolving, on the same terms as `run`: when the same hunk is
	 * already pending, or a whole-file write is pending on its path — that
	 * write will have moved the hunk by the time this one's turn comes, and
	 * the hunk's box is busy meanwhile, so nothing should be asking.
	 */
	runHunk: (
		worktree: string,
		path: string,
		hunkId: string,
		action: () => Promise<unknown>,
	): Promise<void> => {
		const { toggling, discarding, hunks } = writesOf(worktree);
		if (
			toggling.has(path) ||
			discarding.has(path) ||
			hunks.get(path)?.has(hunkId)
		) {
			return Promise.resolve();
		}
		setHunkPending(worktree, path, hunkId, true);
		return enqueue(worktree, action, () =>
			setHunkPending(worktree, path, hunkId, false),
		);
	},

	/** Replaces whatever failure the worktree was showing: the newest is the one to read. */
	fail: (worktree: string, failure: GitWriteFailure) =>
		useGitWriteStore.setState((s) => ({
			failures: { ...s.failures, [worktree]: failure },
		})),

	/**
	 * Only a retry of what failed clears the failure. Another file succeeding
	 * says nothing about the one that did not, and dropping its message would
	 * leave that failure with no explanation on screen.
	 */
	succeed: (worktree: string, paths: string[]) => {
		const failure = useGitWriteStore.getState().failures[worktree];
		if (failure?.paths.some((p) => paths.includes(p))) {
			gitWriteActions.dismissFailure(worktree);
		}
	},

	dismissFailure: (worktree: string) =>
		useGitWriteStore.setState((s) => {
			const { [worktree]: _, ...rest } = s.failures;
			return { failures: rest };
		}),

	reset: () => {
		queues.clear();
		useGitWriteStore.setState({ writes: {}, failures: {} });
	},
};

// A failure names paths in the repository it ran against; after the answer
// flips, that repository is gone, and a later `git init` must not bring back
// its banner. The pending sets are left alone: their requests' settling clears
// them. The same rule as gitSyncStore's.
worktreeActions.onGitRepoChange(() => {
	useGitWriteStore.setState({ failures: {} });
});

export function useWorktreeWrites(worktree: string): GitWrites {
	return useGitWriteStore((s) => s.writes[worktree] ?? IDLE);
}

export function useWriteFailure(worktree: string): GitWriteFailure | null {
	return useGitWriteStore((s) => s.failures[worktree] ?? null);
}
