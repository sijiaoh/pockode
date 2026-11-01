import {
	type InstalledVersion,
	type ServerUpdateCheck,
	type ServerUpdateCheckParams,
	type ServerUpdateParams,
	UPDATE_RPC_TIMEOUT_MS,
} from "@pockode/shared";
import {
	createJSONRPCErrorResponse,
	type JSONRPCClient,
	JSONRPCErrorException,
} from "json-rpc-2.0";

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
	/** The releases this cluster could be updated to (docs/self-update-ui.md). */
	serverUpdateCheck: (force: boolean) => Promise<ServerUpdateCheck>;
	/**
	 * Resolves once the release has replaced the executable, restarting
	 * nothing. A failure rejects with the code `updateFailedReason` reads.
	 */
	serverUpdate: (version: string) => Promise<void>;
}

const UPDATE_TIMEOUT_MESSAGE = "No answer came for the update";

/**
 * Whether `serverUpdate` was given up on by this page's clock rather than
 * answered: the install may still have finished, so its file is not known to
 * be unchanged.
 */
export function isUpdateTimeout(error: unknown): boolean {
	// Code 0 first: only a client-side failure carries it, whatever the
	// server words its errors as.
	return (
		error instanceof JSONRPCErrorException &&
		error.code === 0 &&
		error.message === UPDATE_TIMEOUT_MESSAGE
	);
}

// No timeout of their own but the update's: the node RPCs carry none either,
// the server answers the version and the restart within its 10 s budget for
// running `<path> --version`, and the check within that plus its own 20 s.
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

		serverUpdateCheck: async (force) => {
			const params: ServerUpdateCheckParams = force ? { force } : {};
			return requireClient().request("server.update_check", params);
		},

		serverUpdate: async (version) => {
			const params: ServerUpdateParams = { version };
			await requireClient()
				.timeout(UPDATE_RPC_TIMEOUT_MS, (id) =>
					createJSONRPCErrorResponse(id, 0, UPDATE_TIMEOUT_MESSAGE),
				)
				.request("server.update", params);
		},
	};
}
