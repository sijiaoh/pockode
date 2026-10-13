import type { JSONRPCRequester } from "json-rpc-2.0";
import type { ImageOrigin } from "../../types/contents";
import { requireClient } from "./client";

/**
 * What a raw capability reaches: the one file, or — for a page whose relative
 * URLs load its stylesheets, scripts and images — a directory and everything
 * beneath it. An attachment store is flat, so an attachment is always a file;
 * and the server refuses a directory at the root of the work directory or the
 * commit, since a page's scripts can read the capability out of its own URL.
 */
export type RawTarget =
	| { origin: ImageOrigin; scope: "file" }
	| {
			origin: Exclude<ImageOrigin, { kind: "attachment" }>;
			scope: "directory";
	  };

export interface RawCapability {
	/**
	 * A URL path on the server (put it through `apiUrl`). For a file, the file
	 * itself; for a directory, the directory with a trailing slash, against
	 * which a path beneath it resolves as a relative URL.
	 */
	path: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

interface RawCapabilityParams {
	origin: ImageOrigin["kind"];
	scope: RawTarget["scope"];
	path?: string;
	hash?: string;
	session_id?: string;
	id?: string;
	worktree?: string;
}

interface RawCapabilityResult {
	path: string;
	expires_at: string;
}

export interface RawActions {
	/**
	 * A URL a `<video>`, `<audio>` or `<iframe>` loads by itself, with no
	 * Authorization header: the credential is in the path. It lasts hours, and
	 * no longer than this login's session; a load that fails with 404
	 * `capability_not_found` is the cue to ask again. A work-directory file and
	 * a commit are read from the connection's worktree, an attachment from the
	 * one it names.
	 */
	rawCapability: (target: RawTarget) => Promise<RawCapability>;
}

function toParams({ origin, scope }: RawTarget): RawCapabilityParams {
	switch (origin.kind) {
		case "file":
			return { origin: "file", scope, path: origin.path };
		case "commit":
			return { origin: "commit", scope, hash: origin.hash, path: origin.path };
		case "attachment":
			return {
				origin: "attachment",
				scope,
				session_id: origin.sessionId,
				id: origin.id,
				worktree: origin.worktree,
			};
	}
}

export function createRawActions(
	getClient: () => JSONRPCRequester<void> | null,
): RawActions {
	return {
		rawCapability: async (target) => {
			const result: RawCapabilityResult = await requireClient(
				getClient,
			).request("raw.capability", toParams(target));
			return { path: result.path, expiresAt: Date.parse(result.expires_at) };
		},
	};
}
