import type { ServerUpdateCheck } from "@pockode/shared";
import { useWSStore } from "../lib/wsStore";
import { type ServerReadState, useServerRead } from "./useServerRead";

export type UpdateCheckState = ServerReadState<ServerUpdateCheck>;

/** The check, when the last request for it was answered. */
export function updateCheckOf(state: UpdateCheckState) {
	return state.read?.kind === "read" ? state.read.value : null;
}

/**
 * The cluster's release check (`server.update_check`), apart from the
 * installed read so that a slow GitHub never holds up the version list or
 * Restart. An unforced read only says what the server last found, so the
 * connect and visibility reads are free; only a forced one — the user's press
 * — asks GitHub (docs/self-update-ui.md, "When it checks").
 */
export function useUpdateCheck(): UpdateCheckState {
	const { actions } = useWSStore();
	return useServerRead(actions.serverUpdateCheck);
}
