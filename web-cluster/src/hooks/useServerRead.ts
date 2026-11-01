import { useCallback, useEffect, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";

/** What the last read came back with. */
export type ServerRead<T> =
	| { kind: "read"; value: T }
	/** The request itself failed: not an answer about what it asked. */
	| { kind: "failed"; message: string };

export interface ServerReadState<T> {
	/** Null until the first read lands. */
	read: ServerRead<T> | null;
	/**
	 * The latest answer that did come back, kept through a failed request:
	 * for a decision that should rest on the last thing known rather than be
	 * taken away by a request that failed (the server decides again anyway).
	 */
	last: T | null;
	/** The id of the latest read that landed; 0 before any. */
	landed: number;
	/** The latest read started has neither landed nor gone with the socket. */
	pending: boolean;
	/** Starts a read and returns its id, for `useFreshRead`. */
	refresh: (force?: boolean) => number;
}

/**
 * A read of something about the cluster's host that is never polled — each
 * one costs the host work (running the executable, asking GitHub) — so it
 * happens on connect, on returning to the tab and when a sheet asks; only the
 * latest one started is allowed to land.
 */
export function useServerRead<T>(
	load: (force: boolean) => Promise<T>,
): ServerReadState<T> {
	const { status } = useWSStore();
	const [read, setRead] = useState<ServerRead<T> | null>(null);
	const [last, setLast] = useState<T | null>(null);
	const [landed, setLanded] = useState(0);
	const [requested, setRequested] = useState(0);
	const [settled, setSettled] = useState(0);
	const lastReadRef = useRef(0);
	// Read at call time, so a caller need not keep `load` stable.
	const loadRef = useRef(load);
	loadRef.current = load;

	const refresh = useCallback((force = false) => {
		const id = ++lastReadRef.current;
		setRequested(id);
		void (async () => {
			let next: ServerRead<T>;
			try {
				next = { kind: "read", value: await loadRef.current(force) };
			} catch (err) {
				// A read the dropped socket took down with it is the reconnect's to
				// report; the next connect reads again.
				if (useWSStore.getState().status !== "connected") {
					if (id === lastReadRef.current) setSettled(id);
					return;
				}
				next = {
					kind: "failed",
					message: err instanceof Error ? err.message : "Unknown error",
				};
			}
			if (id !== lastReadRef.current) return;
			setRead(next);
			if (next.kind === "read") setLast(next.value);
			setLanded(id);
			setSettled(id);
		})();
		return id;
	}, []);

	useEffect(() => {
		if (status === "connected") refresh();
	}, [status, refresh]);

	// The user typically comes back from a terminal where they just ran the
	// installer.
	useEffect(() => {
		const onVisibilityChange = () => {
			if (!document.hidden && useWSStore.getState().status === "connected") {
				refresh();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [refresh]);

	return { read, last, landed, pending: requested > settled, refresh };
}

/**
 * For a sheet that speaks about now, not about when the list was drawn: after
 * `begin`, `reading` holds until a read started at or after it lands, and the
 * sheet keeps its confirm disabled meanwhile.
 */
export function useFreshRead(
	state: Pick<ServerReadState<unknown>, "landed" | "refresh">,
) {
	const [since, setSince] = useState<number | null>(null);
	const { refresh } = state;
	const begin = useCallback(() => setSince(refresh()), [refresh]);
	return { reading: since !== null && state.landed < since, begin };
}
