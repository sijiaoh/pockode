import type { InstalledVersion } from "@pockode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";

/** What the last read of the installed executable came back with. */
export type InstalledRead =
	| { kind: "read"; installed: InstalledVersion }
	/** The request itself failed: not an answer about the install. */
	| { kind: "failed"; message: string };

export interface InstalledVersionState {
	/** Null until the first read lands. */
	read: InstalledRead | null;
	/** The id of the latest read that landed; 0 before any. */
	landed: number;
	/** Starts a read and returns its id, for `useFreshRead`. */
	refresh: () => number;
}

/** The installed version, when the last read could tell it. */
export function installedOf(state: InstalledVersionState) {
	return state.read?.kind === "read" ? state.read.installed : null;
}

/** The read answered, and the file did not run: the cluster refuses restarts. */
export function isUnreadable(state: InstalledVersionState) {
	const installed = installedOf(state);
	return installed !== null && installed.version === undefined;
}

/**
 * The one read of the cluster's installed version for the whole panel — the
 * header compares the cluster with it and the cards compare each node, since
 * nodes are started from that same file (docs/restart-ui.md, "One read for the
 * whole panel"). Each read runs the executable on the host, so it happens on
 * connect, on returning to the tab and when a sheet asks, never on the node
 * poll; only the latest one started is allowed to land.
 */
export function useInstalledVersion(): InstalledVersionState {
	const { status, actions } = useWSStore();
	const [read, setRead] = useState<InstalledRead | null>(null);
	const [landed, setLanded] = useState(0);
	const lastReadRef = useRef(0);

	const refresh = useCallback(() => {
		const id = ++lastReadRef.current;
		void (async () => {
			let next: InstalledRead;
			try {
				const result = await actions.serverVersion();
				next = { kind: "read", installed: result.installed };
			} catch (err) {
				// A read the dropped socket took down with it is the reconnect's to
				// report; the next connect reads again.
				if (useWSStore.getState().status !== "connected") return;
				next = {
					kind: "failed",
					message: err instanceof Error ? err.message : "Unknown error",
				};
			}
			if (id !== lastReadRef.current) return;
			setRead(next);
			setLanded(id);
		})();
		return id;
	}, [actions]);

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

	return { read, landed, refresh };
}

/**
 * For a sheet that speaks about now, not about when the list was drawn: after
 * `begin`, `reading` holds until a read started at or after it lands, and the
 * sheet keeps its confirm disabled meanwhile.
 */
export function useFreshRead(state: InstalledVersionState) {
	const [since, setSince] = useState<number | null>(null);
	const { refresh } = state;
	const begin = useCallback(() => setSince(refresh()), [refresh]);
	return { reading: since !== null && state.landed < since, begin };
}
