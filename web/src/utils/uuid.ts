/**
 * A random v4 UUID.
 *
 * `crypto.randomUUID` is only defined in a secure context, and Pockode is
 * reached over plain `http://<LAN-IP>` as a matter of course — a phone opening
 * the server running on a laptop on the same network. What breaks without it is
 * not a corner: every subscription names itself with one of these before it can
 * be opened (no live views at all), and every message sent from this client is
 * identified by one (see messageReducer).
 *
 * `crypto.getRandomValues` carries no such restriction, so the fallback is the
 * same randomness laid out by hand (RFC 4122 §4.4: version in the high nibble
 * of byte 6, variant in the top bits of byte 8).
 */
export function generateUUID(): string {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}
