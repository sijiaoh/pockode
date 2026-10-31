import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useCanvasRevision, useCanvasStore } from "../lib/canvasStore";
import { isInvalidParamsRejection, useWSStore } from "../lib/wsStore";
import type { CanvasHistoryEntry, CanvasSnapshot } from "../types/canvas";
import { asError } from "../utils/errorMessage";

export type SnapshotRead =
	| { status: "loading" }
	| { status: "loaded"; snapshot: CanvasSnapshot }
	| {
			status: "failed";
			error: Error;
			/**
			 * False for a refusal (`InvalidParams`): a revision the canvas does
			 * not have, or one lost from disk, which nothing will bring back.
			 */
			retryable: boolean;
	  };

export interface CanvasHistory {
	/** Newest first; null until the first read has answered. */
	entries: CanvasHistoryEntry[] | null;
	/** The last read of the list failed; `entries` keeps what came before. */
	listError: Error | null;
	retryList: () => void;
	/** The open revision's snapshot; null while no revision is open. */
	snapshot: SnapshotRead | null;
	retrySnapshot: () => void;
}

interface Failure {
	error: Error;
	retryable: boolean;
}

/**
 * The history view's reads (docs/canvas-ui.md §13.5, §15.3) for as long as it
 * is mounted: the list, and the open revision's snapshot.
 *
 * The list is read on mount and again whenever the answer may have changed —
 * a new revision pushed, a canvas call settling while an entry is `pending`,
 * the connection back — with one read in flight at a
 * time and at most one more asked for meanwhile, so a burst of pushes costs
 * two reads and an answer is never overtaken by an older one.
 *
 * Snapshots are read one at a time, the open one only, and kept: a snapshot
 * never changes, so a page stepped back to is not read again.
 */
export function useCanvasHistory(
	sessionId: string,
	revision: number | null,
): CanvasHistory {
	const [entries, setEntries] = useState<CanvasHistoryEntry[] | null>(null);
	const [listError, setListError] = useState<Error | null>(null);
	const mounted = useRef(false);
	const listRead = useRef({ inFlight: false, again: false });

	const askList = useCallback(() => {
		const read = listRead.current;
		if (read.inFlight) {
			read.again = true;
			return;
		}
		read.inFlight = true;
		useWSStore
			.getState()
			.actions.canvasHistory(sessionId)
			.then(
				(listed) => {
					if (!mounted.current) return;
					setEntries(listed);
					setListError(null);
				},
				(error: unknown) => {
					if (mounted.current) setListError(asError(error));
				},
			)
			.finally(() => {
				read.inFlight = false;
				if (read.again && mounted.current) {
					read.again = false;
					askList();
				}
			});
	}, [sessionId]);

	const snapshots = useRef(new Map<number, CanvasSnapshot>());
	const failures = useRef(new Map<number, Failure>());
	const reading = useRef<number | null>(null);
	const wanted = useRef(revision);
	wanted.current = revision;
	// The maps are refs, read in render; this says they changed.
	const [, changed] = useReducer((n: number) => n + 1, 0);

	const pump = useCallback(() => {
		const want = wanted.current;
		if (
			reading.current !== null ||
			want === null ||
			snapshots.current.has(want) ||
			failures.current.has(want)
		) {
			return;
		}
		reading.current = want;
		useWSStore
			.getState()
			.actions.canvasSnapshot(sessionId, want)
			.then(
				(snapshot) => snapshots.current.set(want, snapshot),
				(error: unknown) =>
					failures.current.set(want, {
						error: asError(error),
						retryable: !isInvalidParamsRejection(error),
					}),
			)
			.finally(() => {
				reading.current = null;
				if (!mounted.current) return;
				changed();
				// The page may have moved on while this one was read.
				pump();
			});
	}, [sessionId]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Read on mount, and again on every new pushed revision: a new page joins
	// the list, and the one that was current becomes an earlier one.
	const current = useCanvasRevision(sessionId);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the current revision changes, which `current` names
	useEffect(askList, [askList, current]);

	// `pending` is pushed by nothing: it clears when the call's result is
	// recorded, or its turn ends. So while an entry is pending — or a read is
	// in flight, whose answer may be from before — a settling call asks again.
	const settled = useCanvasStore((state) => state.callsSettled);
	const anyPending = entries?.some((e) => e.fork_blocked === "pending");
	const anyPendingRef = useRef(anyPending);
	anyPendingRef.current = anyPending;
	const seenSettled = useRef(settled);
	useEffect(() => {
		if (seenSettled.current === settled) return;
		seenSettled.current = settled;
		if (anyPendingRef.current || listRead.current.inFlight) askList();
	}, [settled, askList]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: read whenever the open revision changes, which `revision` names
	useEffect(pump, [pump, revision]);

	// A reconnect replays nothing missed, and a read that failed offline is
	// retried once the connection is back.
	const connected = useWSStore((s) => s.status === "connected");
	const wasConnected = useRef(connected);
	useEffect(() => {
		const back = connected && !wasConnected.current;
		wasConnected.current = connected;
		if (!back) return;
		askList();
		for (const [failed, failure] of failures.current) {
			if (failure.retryable) failures.current.delete(failed);
		}
		changed();
		pump();
	}, [connected, askList, pump]);

	const retryList = useCallback(() => {
		setListError(null);
		askList();
	}, [askList]);

	const retrySnapshot = useCallback(() => {
		const open = wanted.current;
		if (open === null) return;
		failures.current.delete(open);
		changed();
		pump();
	}, [pump]);

	let snapshot: SnapshotRead | null = null;
	if (revision !== null) {
		const loaded = snapshots.current.get(revision);
		const failure = failures.current.get(revision);
		snapshot = loaded
			? { status: "loaded", snapshot: loaded }
			: failure
				? { status: "failed", ...failure }
				: { status: "loading" };
	}

	return { entries, listError, retryList, snapshot, retrySnapshot };
}
