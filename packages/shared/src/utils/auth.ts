/**
 * The half of the `auth` RPC that both frontends have to agree with the server
 * on. It lives here rather than in either project because the two clients speak
 * the same protocol to the same handler, and a copy each is a copy that can
 * drift — see `server/rpc/types.go` for the other side.
 */

/**
 * The one credential a connection authenticates with.
 *
 * The password is what the user types; the session token is what the server
 * hands back in exchange for it. They are a tagged union rather than one string
 * because the server refuses a request carrying both and answers the two
 * differently when they are wrong — a bad password is the user's mistake, an
 * unknown session token is nobody's.
 *
 * Named `AuthCredential` and not `Credential`: the DOM has a global of that
 * name, so the shorter one would resolve to something entirely unrelated in
 * every file that forgot the import.
 */
export type AuthCredential =
	| { kind: "password"; value: string }
	| { kind: "session_token"; value: string };

/** The credential member of an `auth` request; never both at once. */
export interface AuthCredentialParams {
	password?: string;
	session_token?: string;
}

export function credentialParams(
	credential: AuthCredential,
): AuthCredentialParams {
	return credential.kind === "password"
		? { password: credential.value }
		: { session_token: credential.value };
}

/**
 * The `data.reason` of the JSON-RPC error an auth refusal replies with. Clients
 * branch on these rather than on the message, which is prose and free to
 * change.
 */
export type AuthFailureReason =
	| "invalid_password"
	| "session_expired"
	| "not_authenticated"
	| "worktree_not_found";

/**
 * The reason on an auth refusal, or null when the error carries none.
 *
 * Only ask this of an error already known to be a refusal the server wrote: a
 * timeout or a dead socket rejects with the same exception type and no `data`,
 * which answers null here and would otherwise read as "refused for no stated
 * reason".
 */
export function authFailureReason(error: unknown): AuthFailureReason | null {
	const data = (error as { data?: { reason?: AuthFailureReason } } | null)
		?.data;
	return data?.reason ?? null;
}
