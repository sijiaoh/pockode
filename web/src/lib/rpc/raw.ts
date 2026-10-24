import type { JSONRPCRequester } from "json-rpc-2.0";
import type { ContentOrigin, TreeOrigin } from "../../types/contents";
import { getApiBaseUrl } from "../../utils/config";
import { requireClient } from "./client";

/**
 * The tree a root capability reaches: the work directory, or a commit.
 */
export type TreeRoot = { kind: "file" } | { kind: "commit"; hash: string };

/**
 * What a raw capability reaches: the one file, or — for a page whose relative
 * URLs load its stylesheets, scripts and images — the whole tree, so that
 * `../` and a script's `fetch("data.json")` resolve as they would on disk. An
 * attachment store is flat, so an attachment is always a file. Since a page's
 * scripts can read the capability out of its own URL, the server's root scope
 * withholds every path with a component starting with `.` (`.env`, `.git`),
 * other worktrees and Pockode's own data.
 */
export type RawTarget = (
	| { origin: ContentOrigin; scope: "file" }
	| { origin: TreeRoot; scope: "root" }
) & {
	/**
	 * Set when what is read is shown as a page: the hosts beyond the server
	 * the reader has allowed it to reach (docs/page-external-hosts-ui.md). The
	 * server binds them to the capability and refuses the page everything
	 * else, so a capability for a page is never the one for another page
	 * unless their hosts are the same.
	 */
	page?: { hosts: readonly string[] };
};

/**
 * Whether a page at `path` has to be shown on its own: the root scope
 * withholds it, having a component that starts with `.`.
 */
export function isHiddenPage(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}

/**
 * What a page at `origin` is loaded through: the root of its tree — or, for a
 * page the root scope withholds (`isHiddenPage`), the page alone. Decided here
 * rather than by asking and falling back, since a refused grant is an error
 * like any other.
 */
export function pageRawTarget(origin: TreeOrigin): RawTarget {
	if (isHiddenPage(origin.path)) return { origin, scope: "file" };
	return {
		origin:
			origin.kind === "commit"
				? { kind: "commit", hash: origin.hash }
				: { kind: "file" },
		scope: "root",
	};
}

/**
 * The URL of the page at `path` under a capability for `target`: the
 * capability itself for a file, the path beneath it — each segment encoded, as
 * the server's own paths are — for a root.
 */
export function pageRawUrl(
	target: RawTarget,
	capabilityUrl: string,
	path: string,
): string {
	return target.scope === "root"
		? capabilityUrl + path.split("/").map(encodeURIComponent).join("/")
		: capabilityUrl;
}

export interface RawCapability {
	/**
	 * A URL path on the server (put it through `apiUrl`). For a file, the file
	 * itself; for a root, the root with a trailing slash, against which a path
	 * beneath it resolves as a relative URL (`pageRawUrl`); for a folder, the
	 * archive.
	 */
	path: string;
	/** Epoch milliseconds. */
	expiresAt: number;
	/**
	 * The worktree it reads from (empty for the main one). For a file or a
	 * commit, the one the connection was bound to when the server answered —
	 * which during a switch may still be the worktree being left.
	 */
	worktree: string;
}

interface RawCapabilityParams {
	origin: ContentOrigin["kind"];
	scope: RawTarget["scope"] | "folder";
	path?: string;
	hash?: string;
	session_id?: string;
	id?: string;
	worktree?: string;
	hosts?: string[];
	base_url?: string;
}

interface RawCapabilityResult {
	path: string;
	expires_at: string;
	worktree: string;
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
	/**
	 * A URL the browser saves the folder at `path` from as one zip archive —
	 * `path` empty for the work directory itself — with what a root capability
	 * withholds left out beneath it. Read from the connection's worktree, as a
	 * file is. Asked for once per download rather than held like a player's:
	 * nothing plays from it.
	 */
	rawFolderCapability: (path: string) => Promise<RawCapability>;
}

function toParams(target: RawTarget): RawCapabilityParams {
	// The base is where the page's own requests go, which only the app knows
	// for certain: a proxy in between may not pass its Host on.
	const page = target.page && {
		hosts: [...target.page.hosts],
		base_url: getApiBaseUrl(),
	};
	return { ...originParams(target), ...page };
}

function originParams(target: RawTarget): RawCapabilityParams {
	const { scope } = target;
	if (target.scope === "root") {
		const { origin } = target;
		return origin.kind === "commit"
			? { origin: "commit", scope, hash: origin.hash }
			: { origin: "file", scope };
	}
	const { origin } = target;
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
	const request = async (
		params: RawCapabilityParams,
	): Promise<RawCapability> => {
		const result: RawCapabilityResult = await requireClient(getClient).request(
			"raw.capability",
			params,
		);
		return {
			path: result.path,
			expiresAt: Date.parse(result.expires_at),
			worktree: result.worktree,
		};
	};
	return {
		rawCapability: (target) => request(toParams(target)),
		rawFolderCapability: (path) =>
			request({ origin: "file", scope: "folder", path }),
	};
}
