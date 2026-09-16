/**
 * The auth token a spawned node server uses for its own auth.
 *
 * It is deliberately *not* the cluster token: one leaked node must not hand
 * over the whole cluster, so `cluster_auth_token` is never reused here.
 *
 * Kept in memory for the session rather than in `localStorage`, which is the
 * one decision worth stating: a reload asks once more, and the price of that
 * is one interaction per session instead of a second long-lived secret sitting
 * in browser storage next to the first. Revisit with real use, not by guess.
 */
let sessionToken: string | null = null;

export function getSessionNodeToken() {
	return sessionToken;
}

export function rememberSessionNodeToken(token: string) {
	sessionToken = token;
}

/** For tests: module state outlives a single `render`. */
export function forgetSessionNodeToken() {
	sessionToken = null;
}

// 64 characters, so each random byte maps to one of them with `& 63` and every
// character stays equally likely — a `% alphabet.length` over a shorter set
// would quietly favour its first few.
const TOKEN_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TOKEN_LENGTH = 32;

export function generateNodeToken() {
	const bytes = new Uint8Array(TOKEN_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => TOKEN_ALPHABET[b & 63]).join("");
}
