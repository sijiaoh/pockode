/**
 * The half of the `cloud_link` namespace both frontends have to agree with
 * the server on: a pockode server, a node and a cluster serve the same
 * methods, so `web` and `web-cluster` read the same shapes and apply the same
 * rules to them. The other side is server/cloudlogin (Status, Flow,
 * Unlinked); the contract is docs/code/cloud-account.md#linking-from-the-ui,
 * and the screens are docs/cloud-link-ui.md.
 */

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

/**
 * Of two copies from the same process, the one with the higher revision: the
 * process's one counter is shared by all its flows, so that is the newer news
 * whatever the ids (docs/code/cloud-account.md#the-status). Copies from
 * different processes do not compare — a new snapshot replaces the held copy
 * outright instead of coming through here.
 */
export function newerFlow(
	held: CloudLinkFlow | null,
	incoming: CloudLinkFlow | undefined,
): CloudLinkFlow | null {
	if (!incoming) return held;
	if (!held || incoming.revision > held.revision) return incoming;
	return held;
}

/** Where: server/rpc/types.go's CodeCloudLinkUnavailable. */
const CLOUD_LINK_UNAVAILABLE_CODE = -32013;

/**
 * Whether the server answered that this process cannot keep a cloud link at
 * all — the OS user has no configuration directory. Nothing short of a
 * restart changes that, so it is shown, never retried.
 */
export function isCloudLinkUnavailable(error: unknown): boolean {
	const { code } = (error as { code?: unknown } | null) ?? {};
	return code === CLOUD_LINK_UNAVAILABLE_CODE;
}

/** A cloud named by its host, so a self-hosted one names itself. */
export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * The user code as `pockode login` prints it: an eight-character code split
 * in two (`BCDF-GHJK`), any other left as it is.
 */
export function displayUserCode(code: string): string {
	return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * The user code for a screen reader, one character at a time ("B C D F, G H
 * J K"), so it is not read out as a word.
 */
export function spokenUserCode(code: string): string {
	return displayUserCode(code)
		.split("-")
		.map((part) => part.split("").join(" "))
		.join(", ");
}
