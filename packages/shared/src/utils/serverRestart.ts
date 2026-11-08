/**
 * The half of the `server` namespace — `server.version`, `server.restart`,
 * `server.update_check`, `server.update` — that both frontends have to agree
 * with the server on: a pockode server and a cluster serve the same methods,
 * so `web` and `web-cluster` read the same shapes. The other side is
 * `server/rpc/types.go`; the contract is docs/code/websocket-rpc.md, "Server:
 * Installed Version and Restart" and "Server: Updating to a Release", and the
 * screens are docs/restart-ui.md and docs/self-update-ui.md.
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

/**
 * The `data.reason` of a refused `server.restart` or `node.restart`, which
 * changed nothing. `older_node` and `not_running` come only from a cluster's
 * `node.restart`; `shutting_down` only from `server.restart`.
 */
export type RestartRefusedReason =
	| "not_runnable"
	| "already_restarting"
	| "shutting_down"
	| "older_node"
	| "not_running";

/** Where: server/rpc/types.go's CodeRestartRefused. */
const RESTART_REFUSED_CODE = -32011;

const RESTART_REFUSED_REASONS: readonly string[] = [
	"not_runnable",
	"already_restarting",
	"shutting_down",
	"older_node",
	"not_running",
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

/** A release the server could be updated to. */
export interface UpdateCandidate {
	channel: "latest" | "alpha";
	/** Without the tag's "v", as the server prints its version. */
	version: string;
	/** The release's GitHub page. */
	notes_url: string;
	/** Why this release cannot be installed here; installable when absent. */
	unavailable?: { reason: "no_asset" | "no_checksums"; message: string };
}

/** The `params` of `server.update_check`. */
export interface ServerUpdateCheckParams {
	/**
	 * Ask the release feed, which only this does: the server honours it at
	 * most once a minute and answers from its cache within that minute.
	 * Without it the answer is what the server already knows, waiting only
	 * for a check already running.
	 */
	force?: boolean;
}

/** The result of `server.update_check`. Its parts are independent. */
export interface ServerUpdateCheck {
	/**
	 * When `candidates` was last confirmed, RFC 3339. Absent with no
	 * `check_error`: this process has not checked yet (no `force` since it
	 * started, or the first is still running) — not "up to date".
	 */
	checked_at?: string;
	/**
	 * Latest, then alpha, each only when newer than both the running and the
	 * installed version; decided by the server, so never ordered here. Kept
	 * from the last good check when `check_error` says a later one failed.
	 */
	candidates: UpdateCandidate[];
	/**
	 * The newest final release, a candidate or not: the release an alpha
	 * candidate is a prerelease beside when latest is not offered.
	 */
	latest_version?: string;
	/** Why there is no fresh answer: a development build, or a failed check. */
	check_error?: { reason: "dev_build" | "unavailable"; message: string };
	/**
	 * Why nothing can be installed on this server, whatever the release;
	 * restarting is unaffected. A reason not listed is an error finding out,
	 * shown by its message.
	 */
	cannot_install?: {
		reason: "dev_build" | "container" | "not_writable" | (string & {});
		message: string;
		/** not_writable: the real executable's directory. */
		dir?: string;
		/** not_writable: what to do instead on the server's OS; `code` in backticks. */
		hint?: string;
	};
	/**
	 * An install under way. With its details when this server runs it (asked
	 * for from any device); without, when another Pockode of the same OS user
	 * does.
	 */
	installing?: {
		version?: string;
		channel?: UpdateCandidate["channel"];
		started_at?: string;
	};
	/** "linux/amd64": what the copy of a release without a build names. */
	platform: string;
	/** "pockode-linux-amd64": the file this server would download. */
	asset: string;
}

/** The `params` of `server.update`; `version` has to be a current candidate. */
export interface ServerUpdateParams {
	version: string;
}

/**
 * The `data.reason` of a failed `server.update`. Every one leaves the
 * executable as it was, but `restore_failed`.
 */
export type UpdateFailedReason =
	| "release_gone"
	| "not_installable"
	| "already_installing"
	| "no_asset"
	| "no_checksums"
	| "download_failed"
	| "checksum_mismatch"
	| "not_runnable"
	| "replace_failed"
	| "restore_failed"
	| "timeout";

/** Where: server/rpc/types.go's CodeUpdateFailed. */
const UPDATE_FAILED_CODE = -32012;

const UPDATE_FAILED_REASONS: readonly string[] = [
	"release_gone",
	"not_installable",
	"already_installing",
	"no_asset",
	"no_checksums",
	"download_failed",
	"checksum_mismatch",
	"not_runnable",
	"replace_failed",
	"restore_failed",
	"timeout",
] satisfies UpdateFailedReason[];

/**
 * Why `server.update` failed, or null if the failure is anything else — a
 * failure none of the reasons describes included, whose message is still the
 * one to show. Recognised by the code and `data.reason`, never the message.
 */
export function updateFailedReason(error: unknown): UpdateFailedReason | null {
	const { code, data } =
		(error as { code?: unknown; data?: { reason?: unknown } } | null) ?? {};
	if (code !== UPDATE_FAILED_CODE) return null;
	const reason = data?.reason;
	return typeof reason === "string" && UPDATE_FAILED_REASONS.includes(reason)
		? (reason as UpdateFailedReason)
		: null;
}

/**
 * The server's budget for one install, from the request's arrival
 * (server/ws/rpc_server_update.go's updateTimeout); the "up to 5 min" copy
 * quotes it. A request timeout for `server.update` needs a wide margin over
 * it: a replacement already begun is not cut short, and on Windows it may
 * wait out antivirus for a minute or two.
 */
export const UPDATE_BUDGET_MS = 5 * 60_000;

/**
 * The request timeout both frontends give `server.update`: the budget, plus
 * margin for a Windows replacement waiting out antivirus. Giving up earlier
 * would report a lost answer for an install that finished.
 */
export const UPDATE_RPC_TIMEOUT_MS = UPDATE_BUDGET_MS + 3 * 60_000;

/** "0.25.0 (latest)": how a candidate is named in every copy. */
export function updateCandidateName(candidate: UpdateCandidate): string {
	return `${candidate.version} (${candidate.channel})`;
}

/** What a failed `server.update` leaves its candidate's row with. */
export type UpdateFailureKind =
	/**
	 * The offer itself changed (gone, no longer installable, another install
	 * first): nothing to say, the next check draws what is there now.
	 */
	| { kind: "recheck" }
	/** Said under the candidate; `retry` when pressing again could help. */
	| { kind: "show"; retry: boolean };

/**
 * How each reason reads in both frontends (docs/self-update-ui.md,
 * "Failed"); null is a failure no reason describes, shown as its message.
 */
export function updateFailureKind(
	reason: UpdateFailedReason | null,
): UpdateFailureKind {
	switch (reason) {
		case "release_gone":
		case "not_installable":
		case "already_installing":
			return { kind: "recheck" };
		// Pressing again cannot go differently: the release's own file is
		// what failed, or (restore_failed) the user has to put the old
		// executable back first.
		case "not_runnable":
		case "restore_failed":
		case "no_asset":
		case "no_checksums":
			return { kind: "show", retry: false };
		case "checksum_mismatch":
		case "download_failed":
		case "replace_failed":
		case "timeout":
		case null:
			return { kind: "show", retry: true };
	}
}
