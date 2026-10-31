/**
 * The half of `server.version` and `server.restart` that both frontends have to
 * agree with the server on: a pockode server and a cluster serve the same two
 * methods, so `web` and `web-cluster` read the same shapes. The other side is
 * `server/rpc/types.go`; the contract is docs/code/websocket-rpc.md, "Server:
 * Installed Version and Restart", and the screens are docs/restart-ui.md.
 */

/** What running the executable on disk with `--version` reported, just now. */
export interface InstalledVersion {
	/** As the server prints it — "0.21.0", "dev" — when it could be read. */
	version?: string;
	/** Why it could not be read, in English; a restart is refused for it too. */
	error?: string;
	/** The executable a restart runs, saved at startup. */
	path: string;
}

/** The `data.reason` of a refused `server.restart`, which changed nothing. */
export type RestartRefusedReason =
	| "not_runnable"
	| "already_restarting"
	| "shutting_down";

/** Where: server/rpc/types.go's CodeRestartRefused. */
const RESTART_REFUSED_CODE = -32011;

const RESTART_REFUSED_REASONS: readonly string[] = [
	"not_runnable",
	"already_restarting",
	"shutting_down",
] satisfies RestartRefusedReason[];

/**
 * Why the server refused a restart, or null if the failure is anything else.
 * Recognised by the code and `data.reason`, never the message, which is prose
 * written to be shown as it is.
 */
export function restartRefusedReason(
	error: unknown,
): RestartRefusedReason | null {
	const { code, data } =
		(error as { code?: unknown; data?: { reason?: unknown } } | null) ?? {};
	if (code !== RESTART_REFUSED_CODE) return null;
	const reason = data?.reason;
	return typeof reason === "string" && RESTART_REFUSED_REASONS.includes(reason)
		? (reason as RestartRefusedReason)
		: null;
}

/**
 * How long after a restart's reply the page stops saying "Restarting" and says
 * it hasn't come back. A minute, not seconds: a reconnect through the cloud
 * relay waits for the new process to register its tunnel again.
 */
export const RESTART_NOT_BACK_MS = 60_000;
