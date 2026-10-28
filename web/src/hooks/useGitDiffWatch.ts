import { useCallback, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type { GitDiffChangedNotification, GitDiffData } from "../types/git";
import { useSubscription } from "./useSubscription";

interface UseGitDiffWatchOptions {
	path: string;
	staged: boolean;
	hideWhitespace?: boolean;
	enabled?: boolean;
}

interface UseGitDiffWatchResult {
	data: GitDiffData | undefined;
	isLoading: boolean;
	/** Why the diff could not be read, until a subscribe succeeds. */
	error: Error | null;
	/**
	 * How many snapshots — subscribe replies — have been applied. One counted
	 * after a write was answered was read after that write, which a
	 * notification already on its way when the write answered need not be.
	 */
	snapshot: number;
	/**
	 * Reads the diff again now rather than at the watcher's next poll, keeping
	 * the one on screen until the new one replaces it: no loading state, which
	 * would empty the scroll box and lose the reader's place.
	 */
	refresh: () => void;
	/**
	 * `snapshot` as of now rather than as of the last render — for a write's
	 * answer, which can land between a snapshot and the render showing it.
	 */
	currentSnapshot: () => number;
}

export function useGitDiffWatch({
	path,
	staged,
	hideWhitespace = false,
	enabled = true,
}: UseGitDiffWatchOptions): UseGitDiffWatchResult {
	const gitDiffSubscribe = useWSStore((s) => s.actions.gitDiffSubscribe);
	const gitDiffUnsubscribe = useWSStore((s) => s.actions.gitDiffUnsubscribe);

	const [data, setData] = useState<GitDiffData | undefined>(undefined);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const [snapshot, setSnapshot] = useState(0);
	const snapshotRef = useRef(0);
	// The diff `refresh` asked for again. Keyed rather than a flag: a refresh
	// overtaken before it subscribes — the page moving to the file's other
	// side, say — never gets to clear it, and the next diff, being a different
	// one, has to show the loading state.
	const soft = useRef<string | null>(null);
	const key = `${path}\0${staged}\0${hideWhitespace}`;

	const subscribe = useCallback(
		async (onNotification: (params: GitDiffChangedNotification) => void) => {
			if (soft.current !== key) setIsLoading(true);
			soft.current = null;
			const result = await gitDiffSubscribe(
				path,
				staged,
				hideWhitespace,
				onNotification,
			);
			return result;
		},
		[gitDiffSubscribe, path, staged, hideWhitespace, key],
	);

	const onNotification = useCallback(
		({ id: _, ...diff }: GitDiffChangedNotification) => {
			setData(diff);
		},
		[],
	);

	const { refresh: resubscribe } = useSubscription<
		GitDiffChangedNotification,
		GitDiffData
	>(subscribe, gitDiffUnsubscribe, onNotification, {
		enabled: enabled && !!path,
		onSubscribed: (initial: GitDiffData) => {
			setData(initial);
			setError(null);
			snapshotRef.current++;
			setSnapshot(snapshotRef.current);
			setIsLoading(false);
		},
		onReset: () => {
			setData(undefined);
			setError(null);
			setIsLoading(true);
		},
		// Said rather than left as a spinner: a subscribe that failed is not
		// tried again until something changes, so the spinner would never end.
		onError: (err) => {
			setData(undefined);
			setError(err instanceof Error ? err : new Error(String(err)));
			setIsLoading(false);
		},
	});

	// Read when the refresh is asked for, not when it was handed out: a write
	// answers a render or more after its press, by which time the page may show
	// another side or setting — and a refresh of the diff it showed then would
	// replace the current one with it. Disabled, there is nothing to refresh: a
	// subscription opened then would be one nothing closes.
	const latest = useRef({ active: false, key, resubscribe });
	latest.current = { active: enabled && !!path, key, resubscribe };
	const refresh = useCallback(() => {
		const current = latest.current;
		if (!current.active) return;
		soft.current = current.key;
		void current.resubscribe();
	}, []);
	const currentSnapshot = useCallback(() => snapshotRef.current, []);

	return { data, isLoading, error, snapshot, refresh, currentSnapshot };
}
