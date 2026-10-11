import { useCallback, useState } from "react";
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

	const subscribe = useCallback(
		async (onNotification: (params: GitDiffChangedNotification) => void) => {
			setIsLoading(true);
			const result = await gitDiffSubscribe(
				path,
				staged,
				hideWhitespace,
				onNotification,
			);
			return result;
		},
		[gitDiffSubscribe, path, staged, hideWhitespace],
	);

	const onNotification = useCallback(
		({ id: _, ...diff }: GitDiffChangedNotification) => {
			setData(diff);
		},
		[],
	);

	useSubscription<GitDiffChangedNotification, GitDiffData>(
		subscribe,
		gitDiffUnsubscribe,
		onNotification,
		{
			enabled: enabled && !!path,
			onSubscribed: (initial: GitDiffData) => {
				setData(initial);
				setIsLoading(false);
			},
			onReset: () => {
				setData(undefined);
				setIsLoading(true);
			},
		},
	);

	return { data, isLoading };
}
