import { useWSStore } from "../lib/wsStore";
import { useSubscription } from "./useSubscription";

export interface UseGitWatchOptions {
	onChanged: () => void;
	enabled?: boolean;
}

export function useGitWatch({
	onChanged,
	enabled = true,
}: UseGitWatchOptions): void {
	const gitSubscribe = useWSStore((s) => s.actions.gitSubscribe);
	const gitUnsubscribe = useWSStore((s) => s.actions.gitUnsubscribe);

	useSubscription(gitSubscribe, gitUnsubscribe, onChanged, { enabled });
}
