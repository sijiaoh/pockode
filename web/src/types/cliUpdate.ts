import type { AgentType } from "./settings";

// Mirrors server/cliupdate (Check, Update and their parts); the contract is in
// docs/code/cli-update.md.

export type CliUpdateCheckState =
	| "up_to_date"
	| "update_available"
	| "not_yet_available"
	| "updating"
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
	/** updating: the running update */
	update_id?: string;
	/** This server's sessions with a process of the CLI running, idle included. */
	running_sessions: number;
}

export type CliUpdatePhase = "running" | "succeeded" | "failed";

export type CliUpdateFailureReason =
	| "command_failed"
	| "not_applied"
	| "timeout"
	| "not_installed"
	| "other";

export interface CliUpdateFailure {
	reason: CliUpdateFailureReason;
	detail?: string;
}

/**
 * One run of a CLI's update command. An event: its versions are what they were
 * then, never the CLI's current version, which only a check reads.
 */
export interface CliUpdate {
	id: string;
	agent: AgentType;
	/** Grows with every change; compare only copies of the same `id`. */
	revision: number;
	phase: CliUpdatePhase;
	from_version?: string;
	target_version?: string;
	/** Read after the update ended, on a failure too. */
	to_version?: string;
	binary_path?: string;
	started_at: string;
	ended_at?: string;
	failure?: CliUpdateFailure;
}

export interface CliUpdateChangedNotification {
	id: string;
	update: CliUpdate | null;
}
