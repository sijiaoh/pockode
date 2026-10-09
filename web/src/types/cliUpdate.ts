import type { AgentType } from "./settings";

// Mirrors server/cliupdate (Check, Update and their parts); the contract is in
// docs/code/cli-update.md.

export type CliUpdateCheckState =
	| "up_to_date"
	| "update_available"
	| "not_yet_available"
	| "updating"
	| "installing"
	| "not_installed"
	| "unavailable";

export interface CliUpdateCheck {
	agent: AgentType;
	state: CliUpdateCheckState;
	/** The version Pockode runs, when it could be read. */
	version?: string;
	/** What `channel` points at, when it could be read. */
	latest_version?: string;
	channel: string;
	/** unavailable, not_installed */
	error?: string;
	/** updating, installing: the running update or install */
	update_id?: string;
	/** This server's sessions with a process of the CLI running, idle included. */
	running_sessions: number;
}

/** An install is an update of its own kind: one record, one subscription. */
export type CliUpdateKind = "update" | "install";

export type CliUpdatePhase = "running" | "succeeded" | "failed";

export type CliUpdateFailureReason =
	| "command_failed"
	| "not_applied"
	| "timeout"
	| "not_installed"
	/** install only: npm could not write its global prefix (EACCES / EPERM) */
	| "permission_denied"
	/** install only: npm succeeded, but its bin directory is not on the PATH */
	| "not_on_path"
	| "other";

export interface CliUpdateFailure {
	reason: CliUpdateFailureReason;
	detail?: string;
}

/**
 * One run of a CLI's update or install command. An event: its versions are
 * what they were then, never the CLI's current version, which only a check
 * reads.
 */
export interface CliUpdate {
	id: string;
	agent: AgentType;
	kind: CliUpdateKind;
	/** Grows with every change; compare only copies of the same `id`. */
	revision: number;
	phase: CliUpdatePhase;
	/** Never set for an install. */
	from_version?: string;
	/** For an install, the channel's release: display only, may be absent. */
	target_version?: string;
	/**
	 * Read after the update ended, on a failure too; an install's only once it
	 * succeeded or timed out.
	 */
	to_version?: string;
	/** An install's is absent until it ends. */
	binary_path?: string;
	started_at: string;
	ended_at?: string;
	failure?: CliUpdateFailure;
}

export interface CliUpdateChangedNotification {
	id: string;
	update: CliUpdate | null;
}

/**
 * Why the server refused a `cli_update.install` before starting anything
 * (error -32003). Its message is a full sentence to show as is.
 */
export type CliInstallRefusedReason =
	| "already_installed"
	| "npm_not_found"
	/** Being updated or installed, here or by another Pockode, or signed in to. */
	| "busy";
