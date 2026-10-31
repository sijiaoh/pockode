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
 * Restart. Never on the node poll: the server's cache keeps GitHub's rate
 * down only if nobody asks for checks nobody looks at
 * (docs/self-update-ui.md, "When it checks").
 */
export function useUpdateCheck(): UpdateCheckState {
	const { actions } = useWSStore();
	return useServerRead(actions.serverUpdateCheck);
}
