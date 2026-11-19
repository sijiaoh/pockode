import { useCallback, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import { asError } from "../utils/errorMessage";
import { useSubscription } from "./useSubscription";

export interface UseFSWatchOptions {
	path: string;
	onChanged: () => void;
	enabled?: boolean;
}

export interface UseFSWatchResult {
	/**
	 * Why the watch could not be opened, while it could not. What is on screen
	 * then stays as it was however the files change, and a failed subscribe is
	 * not tried again until something else changes — so the caller says so
	 * rather than leave a stale view looking live.
	 */
	error: Error | null;
	retry: () => void;
}

export function useFSWatch({
	path,
	onChanged,
	enabled = true,
}: UseFSWatchOptions): UseFSWatchResult {
	const fsSubscribe = useWSStore((s) => s.actions.fsSubscribe);
	const fsUnsubscribe = useWSStore((s) => s.actions.fsUnsubscribe);
	// Held with the path it is about, so a watch moved to another path does
	// not show the last one's failure while it opens.
	const [failure, setFailure] = useState<{
		path: string;
		error: Error;
	} | null>(null);

	const subscribe = useCallback(
		(callback: () => void) => fsSubscribe(path, callback),
		[fsSubscribe, path],
	);

	const { refresh } = useSubscription(subscribe, fsUnsubscribe, onChanged, {
		enabled,
		// Invalidate cache when subscription is (re-)established.
		// While unsubscribed (e.g. component unmounted), FS change notifications
		// are lost; triggering onChanged here ensures stale cache is refreshed.
		onSubscribed: () => {
			setFailure(null);
			onChanged();
		},
		onReset: () => setFailure(null),
		// The same path in another worktree is another watch.
		onWorktreeSwitch: () => setFailure(null),
		onError: (err) => setFailure({ path, error: asError(err) }),
	});

	const retry = useCallback(() => {
		void refresh();
	}, [refresh]);

	return {
		error: failure?.path === path ? failure.error : null,
		retry,
	};
}
