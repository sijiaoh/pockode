import {
	type QueryClient,
	queryOptions,
	skipToken,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { apiUrl } from "../lib/api";
import type { RawCapability } from "../lib/rpc/raw";
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
 * switch has landed (`queryClient.ts`).
 */
export const WORKSPACE_RAW_CAPABILITY_KEY = [
	"raw-capability",
	"workspace",
] as const;

/**
 * A capability is worth one per file, however many players show it: the
 * preview and the viewer share it, and the server holds a bounded number.
 *
 * Its own root rather than under the description's key, where an image's
 * bytes live: the description is invalidated whenever its watch is
 * re-established — every relay reconnect — and a new capability is a new
 * `src`, which drops a playing video's buffer for a file that did not change.
 */
function rawCapabilityKey(
	origin: ContentOrigin,
	worktree: string,
): readonly unknown[] {
	switch (origin.kind) {
		case "file":
			return [...WORKSPACE_RAW_CAPABILITY_KEY, worktree, "file", origin.path];
		case "commit":
			return [
				...WORKSPACE_RAW_CAPABILITY_KEY,
				worktree,
				"commit",
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

function rawCapabilityQuery(origin: ContentOrigin, worktree: string) {
	return queryOptions({
		queryKey: rawCapabilityKey(origin, worktree),
		queryFn: () => wsActions.rawCapability({ origin, scope: "file" }),
		staleTime: (query) => {
			const capability: RawCapability | undefined = query.state.data;
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
 * The URL `origin` streams from, for a one-off use such as a download: the
 * capability the players hold for as long as it still works, not only while
 * it is fresh for them. Renewing it would put a new `src` under a playing
 * video for a request that did not need one.
 */
export async function rawMediaUrl(
	queryClient: QueryClient,
	origin: ContentOrigin,
): Promise<string> {
	const options = rawCapabilityQuery(
		origin,
		useWorktreeStore.getState().current,
	);
	const held = queryClient.getQueryState(options.queryKey);
	// An invalidated one may be for the worktree being left (see
	// `WORKSPACE_RAW_CAPABILITY_KEY`), however long it has to live.
	const capability =
		held?.data &&
		!held.isInvalidated &&
		held.data.expiresAt - ONE_OFF_MARGIN_MS > Date.now()
			? held.data
			: await queryClient.fetchQuery({ ...options, staleTime: 0 });
	return apiUrl(capability.path);
}

/**
 * A URL a `<video>` or `<audio>` streams `origin` from, with Range requests
 * and no Authorization header (docs/code/authentication.md, "Raw
 * capabilities"). Nothing is asked for until `enabled`, nor while the
 * WebSocket is down: the wait shows as loading rather than as a failure the
 * user would have to retry.
 *
 * `refresh` asks for a new capability for a player whose load failed — the
 * old one may have expired or died with its session. The new one arrives as
 * `src`, to every player of the file at once.
 */
export function useRawMediaSource(origin: ContentOrigin, enabled: boolean) {
	const queryClient = useQueryClient();
	const worktree = useWorktreeStore((s) => s.current);
	const connected = useWSStore((s) => s.status === "connected");
	const options = rawCapabilityQuery(origin, worktree);
	const query = useQuery({
		...options,
		queryFn: enabled && connected ? options.queryFn : skipToken,
	});

	const key = JSON.stringify(options.queryKey);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of `options`, which is rebuilt every render
	const refresh = useCallback(
		async (signal: AbortSignal): Promise<void> => {
			await whenConnected(signal);
			await queryClient.fetchQuery({ ...options, staleTime: 0 });
		},
		[queryClient, key],
	);

	return {
		src: query.data ? apiUrl(query.data.path) : null,
		// Withheld while a retry is running, as `useImageSrc` does.
		error: query.isFetching ? null : query.error,
		refresh,
		/**
		 * Changes when the player is for something else and has to start over.
		 * `src` changing alone is the same content under a new capability.
		 */
		key,
	};
}

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
