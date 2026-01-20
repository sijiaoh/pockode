import { useCallback } from "react";
import { useWSStore } from "../lib/wsStore";
import { useSubscription } from "./useSubscription";

export interface UseFSWatchOptions {
	path: string;
	onChanged: () => void;
	enabled?: boolean;
}

export function useFSWatch({
	path,
	onChanged,
	enabled = true,
}: UseFSWatchOptions): void {
	const fsSubscribe = useWSStore((s) => s.actions.fsSubscribe);
	const fsUnsubscribe = useWSStore((s) => s.actions.fsUnsubscribe);

	const subscribe = useCallback(
		(callback: () => void) => fsSubscribe(path, callback),
		[fsSubscribe, path],
	);

	useSubscription(subscribe, fsUnsubscribe, onChanged, { enabled });
}
