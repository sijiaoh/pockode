import { asError } from "../utils/errorMessage";
import { readError } from "./fileDownload";

/**
 * What one byte of a raw capability URL says about it: served, or refused with
 * the server's error `code` (docs/file.md, "File transfer API") and a message
 * for the user. A request that never got an answer is refused with no code.
 */
export type RawProbe =
	| { ok: true }
	| { ok: false; status?: number; code?: string; error: Error };

/**
 * Asks for the first byte of `src`, for an element that cannot see the status
 * behind its own load — a media element's error, an iframe that reports none.
 * A GET rather than a HEAD: only a body tells `capability_not_found` from
 * `not_found`.
 */
export async function probeRaw(
	src: string,
	signal: AbortSignal,
): Promise<RawProbe> {
	try {
		const response = await fetch(src, {
			headers: { Range: "bytes=0-0" },
			signal,
		});
		if (response.ok) {
			void response.body?.cancel();
			return { ok: true };
		}
		const error = await readError(response.clone());
		const code = await response
			.json()
			.then((body: unknown) =>
				body !== null &&
				typeof body === "object" &&
				"code" in body &&
				typeof body.code === "string"
					? body.code
					: undefined,
			)
			.catch(() => undefined);
		return { ok: false, status: response.status, code, error };
	} catch (error) {
		return {
			ok: false,
			error: asError(error),
		};
	}
}

/** The answer of a capability that has expired or died with its session. */
export function isDeadCapability(probe: RawProbe): boolean {
	return (
		!probe.ok && probe.status === 404 && probe.code === "capability_not_found"
	);
}

/** The answer for a file the capability's scope does not reach. */
export function isOutsideScope(probe: RawProbe): boolean {
	return !probe.ok && probe.status === 403 && probe.code === "outside_scope";
}

/** The answer for a file that is no longer there. */
export function isGone(probe: RawProbe): boolean {
	return !probe.ok && probe.status === 404 && probe.code === "not_found";
}
