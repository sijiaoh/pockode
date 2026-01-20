import { useEffect, useRef } from "react";
import { useWSStore } from "../lib/wsStore";

interface SubscriptionOptions {
	enabled?: boolean;
}

/**
 * Generic hook for WebSocket subscription lifecycle management.
 * Handles subscribe/unsubscribe, race conditions, and cleanup.
 */
export function useSubscription(
	subscribe: (callback: () => void) => Promise<string>,
	unsubscribe: (id: string) => Promise<void>,
	onChanged: () => void,
	options: SubscriptionOptions = {},
): void {
	const { enabled = true } = options;
	const status = useWSStore((s) => s.status);

	const onChangedRef = useRef(onChanged);
	onChangedRef.current = onChanged;

	useEffect(() => {
		if (!enabled || status !== "connected") return;

		let subscriptionId: string | null = null;
		let cancelled = false;

		subscribe(() => {
			onChangedRef.current();
		})
			.then((id) => {
				if (cancelled) {
					unsubscribe(id);
				} else {
					subscriptionId = id;
				}
			})
			.catch((err) => {
				console.error("Subscription failed:", err);
			});

		return () => {
			cancelled = true;
			if (subscriptionId) {
				unsubscribe(subscriptionId);
			}
		};
	}, [enabled, status, subscribe, unsubscribe]);
}
