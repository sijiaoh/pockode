import {
	type AuthCredential,
	type AuthCredentialParams,
	credentialParams,
} from "@pockode/shared";

/**
 * A credential this app can connect with: the shared one, or a login ticket
 * the cluster panel put in the address it opened this tab at
 * (docs/code/websocket-rpc.md#logging-in-from-the-cluster), with the session
 * token stored from an earlier visit beside it. The server spends the ticket
 * and keeps a live session, so one `auth` carries both rather than trying the
 * session first.
 *
 * A superset of `AuthCredential` kept out of `@pockode/shared` on purpose:
 * only a node server takes a ticket, and the cluster server would read an auth
 * carrying one and no password as an empty password.
 */
export type AppAuthCredential =
	| AuthCredential
	| { kind: "login_ticket"; value: string; sessionToken: string | null };

export interface AppAuthCredentialParams extends AuthCredentialParams {
	login_ticket?: string;
}

export function appCredentialParams(
	credential: AppAuthCredential,
): AppAuthCredentialParams {
	if (credential.kind !== "login_ticket") return credentialParams(credential);
	return credential.sessionToken
		? { login_ticket: credential.value, session_token: credential.sessionToken }
		: { login_ticket: credential.value };
}

/**
 * What is left of a credential once an `auth` has carried it: a ticket is
 * spent by the attempt whatever its outcome, so a retry has only the session
 * token that came with it, if any.
 */
export function withoutLoginTicket(
	credential: AppAuthCredential,
): AuthCredential | null {
	if (credential.kind !== "login_ticket") return credential;
	return credential.sessionToken
		? { kind: "session_token", value: credential.sessionToken }
		: null;
}

const FRAGMENT_PREFIX = "#login_ticket=";

/**
 * Takes the login ticket out of the address the tab was opened at, and
 * returns it — null when there is none.
 *
 * It has to run before anything copies the address: the router's history
 * trail writes the href it starts on, fragment included, into sessionStorage
 * as soon as it exists (lib/historyTrail.ts), and the browser's own entry
 * would keep it for Back and for a reload. The cluster writes the fragment as
 * exactly this one parameter, so the whole fragment goes.
 */
export function takeLoginTicketFromAddress(): string | null {
	const { hash, pathname, search } = window.location;
	if (!hash.startsWith(FRAGMENT_PREFIX)) return null;
	window.history.replaceState(window.history.state, "", `${pathname}${search}`);
	// base64url, so nothing to decode — and decoding a malformed one would throw
	// at boot.
	return hash.slice(FRAGMENT_PREFIX.length) || null;
}
