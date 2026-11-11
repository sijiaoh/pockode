// Mirrors server/cloudlogin (Status, Flow, Unlinked); the contract is in
// docs/code/cloud-account.md#linking-from-the-ui.

export type CloudLinkCredential = "none" | "linked" | "other_cloud";

export type CloudLinkRelay =
	| "disabled"
	| "pending"
	| "guest"
	| "attached"
	| "link_invalid"
	| "not_attached";

export type CloudLinkPhase =
	| "starting"
	| "waiting"
	| "finishing"
	| "linked"
	| "already_linked"
	| "failed"
	| "canceled";

export type CloudLinkFailureReason = "expired" | "declined" | "other";

/**
 * One link flow, as the server holds it. The user code and the link are
 * secrets — whoever has them can approve the flow into their own account — so
 * they live in component state only: never a route, storage or a log.
 */
export interface CloudLinkFlow {
	id: string;
	/**
	 * One counter for all of a process's flows: of any two copies from the
	 * same process, the higher revision is the newer news.
	 */
	revision: number;
	phase: CloudLinkPhase;
	started_at: string;
	/** From `waiting` on. */
	expires_at?: string;
	/** `waiting` only. */
	user_code?: string;
	/** `waiting` only. */
	verification_url?: string;
	cloud_unreachable?: boolean;
	/** `linked` (when the cloud said) and `already_linked`. */
	email?: string;
	machine_name?: string;
	/** `already_linked` or `failed`: an approved link nothing here uses. */
	left_behind?: boolean;
	failure?: { reason: CloudLinkFailureReason; detail?: string };
}

export interface CloudLinkStatus {
	cloud_url: string;
	credential: CloudLinkCredential;
	/** With `other_cloud`. */
	other_cloud_url?: string;
	relay: CloudLinkRelay;
	/** With `relay: attached`. */
	email?: string;
	/** os_user@hostname; absent when the server could not work it out. */
	machine_name?: string;
	/** The running flow, or the last to end; absent when there was none. */
	flow?: CloudLinkFlow;
}

export interface CloudLinkUnlinked {
	was_linked: boolean;
	/** The cloud the link was with: cloud.json's, which may be another one. */
	cloud_url?: string;
	revoke_error?: string;
}

export interface CloudLinkChangedNotification {
	id: string;
	status: CloudLinkStatus;
}

export function isFlowRunning(flow: CloudLinkFlow): boolean {
	return (
		flow.phase === "starting" ||
		flow.phase === "waiting" ||
		flow.phase === "finishing"
	);
}
