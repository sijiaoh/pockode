import type { InstalledVersion } from "@pockode/shared";
import { useWSStore } from "../lib/wsStore";
import {
	type ServerRead,
	type ServerReadState,
	useServerRead,
} from "./useServerRead";

export { useFreshRead } from "./useServerRead";

/** What the last read of the installed executable came back with. */
export type InstalledRead = ServerRead<InstalledVersion>;

export type InstalledVersionState = ServerReadState<InstalledVersion>;

/** The installed version, when the last read could tell it. */
export function installedOf(state: InstalledVersionState) {
	return state.read?.kind === "read" ? state.read.value : null;
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
 * whole panel"). Each read runs the executable on the host.
 */
export function useInstalledVersion(): InstalledVersionState {
	const { actions } = useWSStore();
	return useServerRead(async () => (await actions.serverVersion()).installed);
}
