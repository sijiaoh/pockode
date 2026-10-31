import type { InstalledVersion } from "@pockode/shared";
import type { JSONRPCClient } from "json-rpc-2.0";

/** `server.version` on a cluster (docs/code/websocket-rpc.md). */
export interface ClusterVersion {
	installed: InstalledVersion;
}

export interface ServerActions {
	/** Runs the installed executable on the cluster's host: never cached. */
	serverVersion: () => Promise<ClusterVersion>;
	/**
	 * Resolves once the cluster has accepted the restart — its connection
	 * closes with 1012 right after. A refusal rejects with the code
	 * `restartRefusedReason` reads, having changed nothing.
	 */
	serverRestart: () => Promise<void>;
}

// No timeout of their own: the node RPCs carry none either, and the server
// answers both within its 10 s budget for running `<path> --version`.
export function createServerActions(
	getClient: () => JSONRPCClient | null,
): ServerActions {
	const requireClient = (): JSONRPCClient => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		serverVersion: async () => requireClient().request("server.version", {}),

		serverRestart: async () => {
			await requireClient().request("server.restart", {});
		},
	};
}
