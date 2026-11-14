import type { AgentType } from "./settings";

// Mirrors server/cliauth (Status, Login and their parts); the contract is in
// docs/code/cli-auth.md.

export type CliAuthState =
	| "signed_in"
	| "signed_out"
	| "external"
	| "not_installed"
	| "signing_in"
	| "updating"
	| "unavailable";

export interface CliAccount {
	email?: string;
	organization?: string;
	plan?: string;
}

export type CliExternalKind =
	| "api_key"
	| "api_key_helper"
	| "oauth_token"
	| "cloud_provider"
	| "no_sign_in_needed"
	| "other";

/** Where credentials Pockode does not manage come from. Names, never values. */
export interface CliExternal {
	kind: CliExternalKind;
	source?: string;
	provider?: string;
	method?: string;
}

export interface CliAuthStatus {
	agent: AgentType;
	/**
	 * The profile (account) the status was read for — resolved by the server
	 * when the request named none. Absent for the default profile.
	 */
	profile_id?: string;
	state: CliAuthState;
	version?: string;
	/** signed_in */
	account?: CliAccount;
	/** external */
	external?: CliExternal;
	/** unavailable, not_installed */
	error?: string;
	/** signing_in: the running sign-in */
	login_id?: string;
	/**
	 * signing_in: the profile the running sign-in is for, absent for the
	 * default one. A CLI signs in one profile at a time, and while it does every
	 * profile of it reads `signing_in`: only the one this names is signing in,
	 * the rest are waiting for it (`isSigningInHere`).
	 */
	login_profile_id?: string;
	/** updating: the running update. Nothing else is read meanwhile. */
	update_id?: string;
}

export type CliAccountKind = "claude_ai" | "console";

export type CliLoginPhase =
	| "starting"
	| "waiting"
	| "verifying"
	| "succeeded"
	| "failed"
	| "canceled";

export type CliLoginFailureReason =
	| "code_rejected"
	| "expired"
	| "device_auth_failed"
	| "not_installed"
	| "external"
	| "flow_broken"
	| "other";

export interface CliLoginFailure {
	reason: CliLoginFailureReason;
	detail?: string;
	external?: CliExternal;
}

/**
 * One sign-in, as the server holds it. Its link and codes are secrets: they
 * live in memory only, never in a route, storage, a draft or a log.
 */
export interface CliLogin {
	id: string;
	agent: AgentType;
	/** The profile being signed in, absent for the default one. */
	profile_id?: string;
	/** Grows with every change of the same `id`; the higher copy is newer. */
	revision: number;
	account_kind?: CliAccountKind;
	phase: CliLoginPhase;
	version?: string;
	started_at: string;
	expires_at: string;
	url?: string;
	/** Codex */
	user_code?: string;
	/** Claude, back in waiting: the last code was incomplete. */
	code_malformed?: boolean;
	failure?: CliLoginFailure;
	/** succeeded: whom the CLI said it signed in as, then. Not live status. */
	account?: CliAccount;
}

export interface CliLoginChangedNotification {
	id: string;
	login: CliLogin;
}
