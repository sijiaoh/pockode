/**
 * The password a spawned node server is started with and authenticates by.
 *
 * It is deliberately *not* the cluster's own password: one leaked node must not
 * hand over the whole cluster, so the cluster credential is never reused here.
 */

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
