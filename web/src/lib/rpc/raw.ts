import type { JSONRPCRequester } from "json-rpc-2.0";
import type { ContentOrigin, TreeOrigin } from "../../types/contents";
import { parentDir, splitPath } from "../../utils/path";
import { requireClient } from "./client";

/**
 * What a raw capability reaches: the one file, or — for a page whose relative
 * URLs load its stylesheets, scripts and images — a directory and everything
 * beneath it. An attachment store is flat, so an attachment is always a file;
 * and the server refuses a directory at the root of the work directory or the
 * commit, or one with a component starting with `.`, since a page's scripts
 * can read the capability out of its own URL — and with it `.env` or `.git`.
 * A directory capability never serves a dotfile beneath it either.
 */
export type RawTarget =
	| { origin: ContentOrigin; scope: "file" }
	| { origin: TreeOrigin; scope: "directory" };

/**
 * What a page at `origin` is loaded through: the directory it sits in, so its
 * relative URLs reach its assets — or, where the server would refuse that
 * directory or the page itself (see `RawTarget`), the page alone. Decided
 * here rather than by asking and falling back, since a refused grant is an
 * error like any other.
 */
export function pageRawTarget(origin: TreeOrigin): RawTarget {
	if (pageIsolation(origin.path)) return { origin, scope: "file" };
	return {
		origin: { ...origin, path: parentDir(origin.path) },
		scope: "directory",
	};
}

/**
 * Why a page gets a capability for itself alone, and so cannot load the files
 * it links to — or null when its directory's capability reaches them. Each
 * flag is a reason on its own; more than one can hold.
 */
export interface PageIsolation {
	/** At the root of the work directory or the commit. */
	root: boolean;
	/** Beneath a directory whose name starts with `.`. */
	hiddenFolder: boolean;
	/**
	 * Its own name starts with `.`: a directory capability serves no dotfile
	 * beneath it, the page included.
	 */
	hiddenName: boolean;
	/**
	 * Its directory's capability could not reach it: the directory or one
	 * above it is a link, which a directory scope never follows, the page is a
	 * link out of it, or the folder could not be read. Known only once the
	 * server has said so (`usePageFrame`), never from the path.
	 */
	unreachableFolder: boolean;
}

export function pageIsolation(path: string): PageIsolation | null {
	const dir = parentDir(path);
	const isolation = {
		root: dir === "",
		hiddenFolder: dir.split("/").some((part) => part.startsWith(".")),
		hiddenName: splitPath(path).fileName.startsWith("."),
		unreachableFolder: false,
	};
	return isolation.root || isolation.hiddenFolder || isolation.hiddenName
		? isolation
		: null;
}

/**
 * The page's own URL under the capability `pageRawTarget` asked for: the
 * capability itself for a file, the page's name beneath it for a directory.
 */
export function pageRawUrl(
	target: RawTarget,
	capabilityUrl: string,
	fileName: string,
): string {
	return target.scope === "directory"
		? capabilityUrl + encodeURIComponent(fileName)
		: capabilityUrl;
}

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
	origin: ContentOrigin["kind"];
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
