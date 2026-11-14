import type { CliAuthStatus } from "./cliAuth";
import type { AgentType } from "./settings";

// Mirrors server/cliprofile (Overview, Profile, Conflict) and the cli_profile.*
// results in server/rpc; the contract is in docs/code/cli-profiles.md.

/**
 * The ID of every CLI's default profile — the directory the CLI uses without
 * Pockode. Implicit: it is never in a list, has no name, and is what a status
 * or a record without `profile_id` was for.
 */
export const DEFAULT_PROFILE_ID = "";

/** A stored profile. Its directory is named by `id`, never by `name`. */
export interface CliProfile {
	id: string;
	name: string;
}

/** One CLI's profiles. */
export interface CliProfileList {
	agent: AgentType;
	/** Absent: the default profile is current. */
	current_profile_id?: string;
	/** The stored profiles, in their order. Never the default one. */
	profiles: CliProfile[];
}

/** Every CLI's profiles, as `cli_profile.subscribe` answers and pushes them. */
export interface CliProfileOverview {
	/**
	 * Whether this machine can run a CLI as anything but its default profile.
	 * The lists are still shown when it cannot: they are shared with every
	 * Pockode process of the OS user, and one that can use them follows them.
	 */
	available: boolean;
	/** When not available: why, for the user. */
	unavailable_reason?: string;
	/** In display order. */
	clis: CliProfileList[];
}

/** An entry the profile should share with the default profile but does not. */
export interface CliProfileConflict {
	name: string;
	/** The profile's own copy of it. */
	path: string;
}

/** One profile as its directory has it now. */
export interface CliProfileInspection {
	/** Its sign-in, as `cli_auth.status` reads it; names the profile. */
	status: CliAuthStatus;
	conflicts?: CliProfileConflict[];
	/** Why `conflicts` could not be read; says nothing about the sign-in. */
	conflicts_error?: string;
}

export interface CliProfileChangedNotification {
	id: string;
	profiles: CliProfileOverview;
}

/**
 * Why `cli_profile.remove` refused (`-32014`). The profile is left as it was:
 * listed, signed in, its directory untouched.
 */
export type CliProfileRemoveRefusedReason =
	/** The profile is current: switch to another first. */
	| "current"
	/** Sessions of this server are mid-turn on it; see `sessions`. */
	| "in_use"
	/** The CLI is signing in — this profile or another. */
	| "signing_in"
	/** The CLI is being updated or installed. */
	| "updating"
	/** Another request is removing the same profile. */
	| "removing"
	/** The sign-out failed; the message carries the CLI's error. */
	| "sign_out_failed"
	/** CLIs told to stop for the removal had not exited yet; a retry waits. */
	| "still_exiting";

/** A session of this server whose CLI runs as a profile. */
export interface CliProfileUser {
	/** Absent for the main worktree. */
	worktree?: string;
	session_id: string;
}

export interface CliProfileRemoveRefusal {
	reason: CliProfileRemoveRefusedReason;
	/** in_use: the sessions still mid-turn on the profile. */
	sessions: CliProfileUser[];
	/** The server's whole explanation, in English. */
	message: string;
}
