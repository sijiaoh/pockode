import {
	type QueryClient,
	queryOptions,
	skipToken,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { apiUrl } from "../lib/api";
import { FOLDER_ERROR_MESSAGES } from "../lib/fileDownload";
import {
	isDeadCapability,
	probeArchive,
	probeRaw,
	saveProbedUrl,
} from "../lib/rawProbe";
import type { RawCapability, RawTarget } from "../lib/rpc/raw";
import { useWorktreeStore } from "../lib/worktreeStore";
import { useWSStore, wsActions } from "../lib/wsStore";
import type { ContentOrigin } from "../types/contents";

/**
 * How long before its expiry a capability stops being handed to a new player.
 * A player started on it then has this long before its next Range request
 * meets a dead URL — which it recovers from anyway (`useMediaPlayback`).
 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Capabilities for content read from the connection's worktree — a file, a
 * commit — as opposed to an attachment, which names its own. The server binds
 * them to the worktree the connection is on when they are issued, and the
 * store's worktree moves before the connection does, so one asked for during a
 * switch may serve the worktree being left: these are invalidated once the
 * switch has landed (`invalidateWorkspaceCapabilities`).
 */
export const WORKSPACE_RAW_CAPABILITY_KEY = [
	"raw-capability",
	"workspace",
] as const;

/**
 * How many worktree switches have landed. A workspace capability asked for
 * before the latest may serve the worktree that was left; what a reader
 * loaded from one it has to load again — which only a page, which never
 * otherwise swaps its `src`, needs to be told. A count stamped on each request
 * as it is sent, rather than the cache's `isInvalidated` (a failed fetch sets
 * that too) or a time (a fetch finishing after the switch was asked for
 * before it, and two in one millisecond cannot be told apart).
 */
let switchEpoch = 0;

/** Called once a worktree switch has landed (`queryClient.ts`). */
export function invalidateWorkspaceCapabilities(queryClient: QueryClient) {
	switchEpoch += 1;
	return queryClient.invalidateQueries({
		queryKey: WORKSPACE_RAW_CAPABILITY_KEY,
	});
}

/**
 * A capability is worth one per file — for pages, one per tree — however many
 * players show it: the preview and the viewer share it, and the server holds
 * a bounded number.
 *
 * Its own root rather than under the description's key, where an image's
 * bytes live: the description is invalidated whenever its watch is
 * re-established — every relay reconnect — and a new capability is a new
 * `src`, which drops a playing video's buffer for a file that did not change.
 *
 * The scope is part of it: a root capability reaches every page in its tree,
 * which all share it, and a file capability its one file. An attachment is
 * always a file. So are a page's hosts: a capability with hosts allowed must
 * not be the one another page opened without them is handed.
 */
function rawCapabilityKey(
	target: RawTarget,
	worktree: string,
): readonly unknown[] {
	const key = originKey(target, worktree);
	return target.page ? [...key, "page", ...target.page.hosts] : key;
}

function originKey(target: RawTarget, worktree: string): readonly unknown[] {
	const { scope } = target;
	if (target.scope === "root") {
		const { origin } = target;
		return [
			...WORKSPACE_RAW_CAPABILITY_KEY,
			worktree,
			origin.kind,
			scope,
			...(origin.kind === "commit" ? [origin.hash] : []),
		];
	}
	const { origin } = target;
	switch (origin.kind) {
		case "file":
			return [
				...WORKSPACE_RAW_CAPABILITY_KEY,
				worktree,
				"file",
				scope,
				origin.path,
			];
		case "commit":
			return [
				...WORKSPACE_RAW_CAPABILITY_KEY,
				worktree,
				"commit",
				scope,
				origin.hash,
				origin.path,
			];
		case "attachment":
			return [
				"raw-capability",
				"attachment",
				origin.worktree,
				origin.sessionId,
				origin.id,
			];
	}
}

function rawCapabilityQuery(target: RawTarget, worktree: string) {
	return queryOptions({
		queryKey: rawCapabilityKey(target, worktree),
		queryFn: async (): Promise<HeldCapability> => {
			const epoch = switchEpoch;
			return { ...(await wsActions.rawCapability(target)), epoch };
		},
		staleTime: (query) => {
			const capability: HeldCapability | undefined = query.state.data;
			return capability
				? Math.max(0, capability.expiresAt - EXPIRY_MARGIN_MS - Date.now())
				: 0;
		},
		// A refetch is a new `src`, and swapping one under a playing element
		// stutters it: a player asks for a fresh one when its own load fails
		// (`refresh`), not when the window regains focus.
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}

/**
 * How long a capability has to live for a one-off request to be started on it.
 * A download is one request, which the server admits once and then streams.
 */
const ONE_OFF_MARGIN_MS = 30 * 1000;

/**
 * A capability for a one-off use of `origin`, such as a download: the one the
 * players hold for as long as it still works, not only while it is fresh for
 * them. Renewing it would put a new `src` under a playing video for a request
 * that did not need one.
 */
async function oneOffCapability(
	queryClient: QueryClient,
	origin: ContentOrigin,
	worktree: string,
	renew: boolean,
): Promise<HeldCapability> {
	const options = rawCapabilityQuery({ origin, scope: "file" }, worktree);
	const held = queryClient.getQueryState(options.queryKey)?.data;
	return !renew &&
		held &&
		serves(origin, held, worktree) &&
		held.expiresAt - ONE_OFF_MARGIN_MS > Date.now()
		? held
		: await queryClient.fetchQuery({ ...options, staleTime: 0 });
}

/**
 * Whether `capability` reads from `worktree`. The store moves before the
 * connection does, and the server answers requests concurrently, so one asked
 * for while a switch is in flight may have been bound to the worktree being
 * left — which no count of landed switches can tell before it lands. An
 * attachment names its own worktree.
 */
function serves(
	origin: ContentOrigin,
	capability: RawCapability,
	worktree: string,
): boolean {
	return origin.kind === "attachment" || capability.worktree === worktree;
}

const WORKTREE_CHANGED = "The worktree changed before the download started.";
const WORKTREE_SWITCHING =
	"The worktree is still switching. Try again in a moment.";

/**
 * Saves `origin` to disk under `fileName`, streamed by the browser from a raw
 * capability rather than read into memory here — a recording can be hundreds
 * of megabytes, more than a phone's tab survives holding.
 *
 * Its first byte is asked for before the browser is handed it, as
 * `saveCheckedUrl` does. A capability that died early — its session ended —
 * or one bound to the worktree a switch is leaving is renewed once, as a
 * player renews its own. The file is the one in the worktree the save
 * started in: a switch meanwhile fails it rather than saving the same path
 * from the other worktree under this one's name. Rejects with `signal`'s
 * reason once it is aborted, and then saves nothing.
 */
export async function saveRawFile(
	queryClient: QueryClient,
	origin: ContentOrigin,
	fileName: string,
	signal: AbortSignal = new AbortController().signal,
): Promise<void> {
	const worktree = useWorktreeStore.getState().current;
	for (let renew = false; ; renew = true) {
		const capability = await oneOffCapability(
			queryClient,
			origin,
			worktree,
			renew,
		);
		signal.throwIfAborted();
		const url = apiUrl(capability.path);
		const probe = await probeRaw(url, signal);
		signal.throwIfAborted();
		if (
			origin.kind !== "attachment" &&
			useWorktreeStore.getState().current !== worktree
		) {
			throw new Error(WORKTREE_CHANGED);
		}
		const current = serves(origin, capability, worktree);
		if (!renew && (!current || isDeadCapability(probe))) continue;
		if (!current) {
			throw new Error(WORKTREE_SWITCHING);
		}
		saveProbedUrl(url, fileName, probe);
		return;
	}
}

/**
 * Saves the folder at `path` — the work directory for "" — as a zip archive
 * the server builds while the browser streams it to disk, under the name the
 * server gives it: only the server knows the work directory's own name.
 *
 * Checked before the hand-over as `saveRawFile` checks a file, since past it
 * a refusal — too large, a file that cannot be read — would fail out of sight.
 * The capability is a fresh one each time, so there is none to renew; one
 * bound to the worktree a switch is leaving fails rather than saving the other
 * worktree's folder. Rejects with `signal`'s reason once it is aborted, and
 * then saves nothing.
 */
export async function saveRawFolder(
	path: string,
	signal: AbortSignal,
): Promise<void> {
	const worktree = useWorktreeStore.getState().current;
	const capability = await wsActions.rawFolderCapability(path);
	signal.throwIfAborted();
	if (capability.worktree !== worktree) throw new Error(WORKTREE_SWITCHING);
	const url = apiUrl(capability.path);
	const probe = await probeArchive(url, signal, FOLDER_ERROR_MESSAGES);
	signal.throwIfAborted();
	if (useWorktreeStore.getState().current !== worktree) {
		throw new Error(WORKTREE_CHANGED);
	}
	saveProbedUrl(url, "", probe);
}

/**
 * A URL a `<video>`, `<audio>` or page `<iframe>` loads `target` from, with
 * Range requests and no Authorization header (docs/code/authentication.md,
 * "Raw capabilities"). Nothing is asked for until `enabled`, nor while the
 * WebSocket is down: the wait shows as loading rather than as a failure the
 * user would have to retry.
 *
 * `refresh` asks for a new capability for a player whose load failed — the
 * old one may have expired or died with its session. The new one arrives as
 * `src`, to every player of the file at once, and is what it resolves to.
 */
export function useRawMediaSource(target: RawTarget, enabled: boolean) {
	const queryClient = useQueryClient();
	const worktree = useWorktreeStore((s) => s.current);
	const connected = useWSStore((s) => s.status === "connected");
	const options = rawCapabilityQuery(target, worktree);
	const query = useQuery({
		...options,
		queryFn: enabled && connected ? options.queryFn : skipToken,
	});

	const key = JSON.stringify(options.queryKey);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of `options`, which is rebuilt every render
	const request = useCallback(
		async (signal: AbortSignal, renew: boolean): Promise<RawSource> => {
			await whenConnected(signal);
			const capability = await queryClient.fetchQuery(
				renew ? { ...options, staleTime: 0 } : options,
			);
			return { src: apiUrl(capability.path), epoch: capability.epoch };
		},
		[queryClient, key],
	);
	const refresh = useCallback(
		(signal: AbortSignal) => request(signal, true),
		[request],
	);
	/**
	 * The capability on hand while it is still fresh for a new load, and a new
	 * one otherwise — for a page about to load again, which needs one that will
	 * last but has no reason to think the one it has is dead.
	 */
	const fresh = useCallback(
		(signal: AbortSignal) => request(signal, false),
		[request],
	);

	return {
		src: query.data ? apiUrl(query.data.path) : null,
		// Withheld while a retry is running, as `useImageSrc` does.
		error: query.isFetching ? null : query.error,
		refresh,
		fresh,
		/** The switch count the capability in `src` was asked for under. */
		epoch: query.data?.epoch ?? 0,
		/**
		 * A capability asked for under an earlier count may serve the worktree
		 * that was left (`switchEpoch`). Never for an attachment, which names
		 * its own.
		 */
		currentEpoch: target.origin.kind === "attachment" ? 0 : switchEpoch,
		/**
		 * Changes when the player is for something else and has to start over.
		 * `src` changing alone is the same content under a new capability.
		 */
		key,
	};
}

/** A capability's URL, and the switch count it was asked for under. */
export interface RawSource {
	src: string;
	epoch: number;
}

type HeldCapability = RawCapability & { epoch: number };

/**
 * Resolves once the WebSocket is connected. A failed load is often the relay
 * dropping, and asking for a capability before it is back would turn a
 * reconnect into a failure card.
 */
function whenConnected(signal: AbortSignal): Promise<void> {
	if (useWSStore.getState().status === "connected") return Promise.resolve();
	return new Promise((resolve, reject) => {
		const unsubscribe = useWSStore.subscribe((state) => {
			if (state.status !== "connected") return;
			unsubscribe();
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
		const onAbort = () => {
			unsubscribe();
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
