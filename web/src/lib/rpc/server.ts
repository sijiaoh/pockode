import type {
	InstalledVersion,
	ServerUpdateCheck,
	ServerUpdateCheckParams,
	ServerUpdateParams,
} from "@pockode/shared";
import type { JSONRPCRequester } from "json-rpc-2.0";
import { requireClient } from "./client";

/** `server.version` on a pockode server (docs/code/websocket-rpc.md). */
export interface ServerVersion {
	installed: InstalledVersion;
	/** Sessions, across every worktree, whose turn a restart would stop. */
	running_turns: number;
}

export interface ServerActions {
	/** Runs the installed executable on the server: never cached. */
	serverVersion: () => Promise<ServerVersion>;
	/**
	 * Resolves once the server has accepted the restart — its connection
	 * closes with 1012 right after. A refusal rejects with the code
	 * `restartRefusedReason` reads, having changed nothing.
	 */
	serverRestart: () => Promise<void>;
	/** The releases this server could be updated to; cached by the server. */
	serverUpdateCheck: (
		params?: ServerUpdateCheckParams,
	) => Promise<ServerUpdateCheck>;
	/**
	 * Resolves once the file on disk has been replaced, without restarting. A
	 * failure rejects with the code `updateFailedReason` reads.
	 */
	serverUpdate: (params: ServerUpdateParams) => Promise<void>;
}

// The default timeout is enough for `server.version` and `server.restart`:
// both answer within the server's 10 s budget for running `<path> --version`.
// `server.update_check` runs that and then waits on the release check — its
// own when forced, else one already running — so it takes the client
// `getCheckClient` gives, and `server.update` the one `getUpdateClient`
// gives, whose timeout stays clear of the install's own budget
// (UPDATE_BUDGET_MS). Both numbers are wsStore's.
export function createServerActions(
	getClient: () => JSONRPCRequester<void> | null,
	getCheckClient: () => JSONRPCRequester<void> | null,
	getUpdateClient: () => JSONRPCRequester<void> | null,
): ServerActions {
	return {
		serverVersion: async () =>
			await requireClient(getClient).request("server.version", {}),

		serverRestart: async () => {
			await requireClient(getClient).request("server.restart", {});
		},

		serverUpdateCheck: async (params = {}) =>
			await requireClient(getCheckClient).request(
				"server.update_check",
				params,
			),

		serverUpdate: async (params) => {
			await requireClient(getUpdateClient).request("server.update", params);
		},
	};
}
