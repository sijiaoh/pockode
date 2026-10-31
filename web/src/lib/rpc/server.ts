import type { InstalledVersion } from "@pockode/shared";
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
}

// The default timeout is enough: both answer within the server's 10 s budget
// for running `<path> --version`.
export function createServerActions(
	getClient: () => JSONRPCRequester<void> | null,
): ServerActions {
	return {
		serverVersion: async () =>
			await requireClient(getClient).request("server.version", {}),

		serverRestart: async () => {
			await requireClient(getClient).request("server.restart", {});
		},
	};
}
