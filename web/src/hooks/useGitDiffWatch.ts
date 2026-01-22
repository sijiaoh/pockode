import { useCallback, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import type {
	GitDiffChangedNotification,
	GitDiffData,
	GitDiffSubscribeResult,
} from "../types/git";
import { useSubscription } from "./useSubscription";

interface UseGitDiffWatchOptions {
	path: string;
	staged: boolean;
	enabled?: boolean;
}

interface UseGitDiffWatchResult {
	data: GitDiffData | undefined;
	isLoading: boolean;
}

export function useGitDiffWatch({
	path,
	staged,
	enabled = true,
}: UseGitDiffWatchOptions): UseGitDiffWatchResult {
	const gitDiffSubscribe = useWSStore((s) => s.actions.gitDiffSubscribe);
	const gitDiffUnsubscribe = useWSStore((s) => s.actions.gitDiffUnsubscribe);

	const [data, setData] = useState<GitDiffData | undefined>(undefined);
	const [isLoading, setIsLoading] = useState(true);

	const subscribe = useCallback(
		async (onNotification: (params: GitDiffChangedNotification) => void) => {
			setIsLoading(true);
			const result = await gitDiffSubscribe(path, staged, onNotification);
			return result;
		},
		[gitDiffSubscribe, path, staged],
	);

	const onNotification = useCallback((params: GitDiffChangedNotification) => {
		setData({
			diff: params.diff,
			old_content: params.old_content,
			new_content: params.new_content,
		});
	}, []);

	useSubscription<GitDiffChangedNotification, GitDiffSubscribeResult>(
		subscribe,
		gitDiffUnsubscribe,
		onNotification,
		{
			enabled: enabled && !!path,
			onSubscribed: (initial: GitDiffSubscribeResult) => {
				setData({
					diff: initial.diff,
					old_content: initial.old_content,
					new_content: initial.new_content,
				});
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
