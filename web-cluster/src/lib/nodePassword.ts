/**
 * The password a spawned node server is started with and authenticates by.
 *
 * It is deliberately *not* the cluster's own password: one leaked node must not
 * hand over the whole cluster, so the cluster credential is never reused here.
 *
 * Kept in memory for the session rather than in `localStorage`, which is the
 * one decision worth stating: a reload asks once more, and the price of that
 * is one interaction per session instead of a second long-lived secret sitting
 * in browser storage next to the first. Revisit with real use, not by guess.
 */
let sessionPassword: string | null = null;

export function getSessionNodePassword() {
	return sessionPassword;
}

export function rememberSessionNodePassword(password: string) {
	sessionPassword = password;
}

/** For tests: module state outlives a single `render`. */
export function forgetSessionNodePassword() {
	sessionPassword = null;
}

// 64 characters, so each random byte maps to one of them with `& 63` and every
// character stays equally likely — a `% alphabet.length` over a shorter set
// would quietly favour its first few.
const PASSWORD_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const PASSWORD_LENGTH = 32;

export function generateNodePassword() {
	const bytes = new Uint8Array(PASSWORD_LENGTH);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => PASSWORD_ALPHABET[b & 63]).join("");
}
