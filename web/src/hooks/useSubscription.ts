import { useCallback, useEffect, useRef } from "react";
import { worktreeActions } from "../lib/worktreeStore";
import { useWSStore } from "../lib/wsStore";

interface SubscriptionOptions<TInitial> {
	enabled?: boolean;
	/**
	 * Resubscribe when worktree changes.
	 * Server resets worktree-scoped subscriptions on switch.
	 * @default true
	 */
	resubscribeOnWorktreeChange?: boolean;
	/**
	 * Called when subscription succeeds with initial data (if any).
	 */
	onSubscribed?: (initial: TInitial) => void;
	/**
	 * Called when subscription is reset: on disable, disconnect, or worktree change.
	 */
	onReset?: () => void;
	/**
	 * Called when subscription fails with an error.
	 * If not provided, falls back to onReset.
	 */
	onError?: (err: unknown) => void;
}

interface SubscribeResult<TInitial> {
	id: string;
	initial?: TInitial;
}

/**
 * Generic hook for WebSocket subscription lifecycle management.
 * Handles subscribe/unsubscribe, race conditions, cleanup, and worktree changes.
 *
 * @typeParam TNotification - Type of notification params (void for parameterless notifications)
 * @typeParam TInitial - Type of initial data returned by subscribe (void if none)
 *
 * @param subscribe - Function to subscribe. Receives notification callback, returns { id, initial? }.
 * @param unsubscribe - Function to unsubscribe by id.
 * @param onNotification - Called when a notification is received.
 * @param options - Configuration options.
 */
export function useSubscription<TNotification = void, TInitial = void>(
	subscribe: (
		onNotification: (params: TNotification) => void,
	) => Promise<SubscribeResult<TInitial>>,
	unsubscribe: (id: string) => Promise<void>,
	onNotification: (params: TNotification) => void,
	options: SubscriptionOptions<TInitial> = {},
): { refresh: () => Promise<void> } {
	const {
		enabled = true,
		resubscribeOnWorktreeChange = true,
		onSubscribed,
		onReset,
		onError,
	} = options;
	const status = useWSStore((s) => s.status);
	const isConnected = status === "connected";

	const onNotificationRef = useRef(onNotification);
	onNotificationRef.current = onNotification;

	const onSubscribedRef = useRef(onSubscribed);
	onSubscribedRef.current = onSubscribed;

	const onResetRef = useRef(onReset);
	onResetRef.current = onReset;

	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	const subscriptionIdRef = useRef<string | null>(null);
	const generationRef = useRef(0);

	const doSubscribe = useCallback(async () => {
		const generation = ++generationRef.current;
		const isStale = () => generationRef.current !== generation;

		if (subscriptionIdRef.current) {
			await unsubscribe(subscriptionIdRef.current);
			subscriptionIdRef.current = null;
		}

		if (isStale()) return;

		try {
			const result = await subscribe((params) => {
				if (isStale()) return;
				onNotificationRef.current(params);
			});

			if (isStale()) {
				await unsubscribe(result.id);
				return;
			}

			subscriptionIdRef.current = result.id;
			if ("initial" in result && onSubscribedRef.current) {
				onSubscribedRef.current(result.initial as TInitial);
			}
		} catch (err) {
			console.error("Subscription failed:", err);
			if (!isStale()) {
				if (onErrorRef.current) {
					onErrorRef.current(err);
				} else {
					onResetRef.current?.();
				}
			}
		}
	}, [subscribe, unsubscribe]);

	const invalidate = useCallback(() => {
		generationRef.current++;
		if (subscriptionIdRef.current) {
			unsubscribe(subscriptionIdRef.current);
			subscriptionIdRef.current = null;
		}
	}, [unsubscribe]);

	useEffect(() => {
		if (!enabled || !isConnected) {
			invalidate();
			onResetRef.current?.();
			return;
		}

		doSubscribe();

		const cleanupSwitchStart = resubscribeOnWorktreeChange
			? worktreeActions.onWorktreeSwitchStart(() => {
					invalidate();
					onResetRef.current?.();
				})
			: undefined;

		const cleanupSwitchEnd = resubscribeOnWorktreeChange
			? worktreeActions.onWorktreeSwitchEnd(doSubscribe)
			: undefined;

		return () => {
			cleanupSwitchStart?.();
			cleanupSwitchEnd?.();
			invalidate();
		};
	}, [
		enabled,
		isConnected,
		doSubscribe,
		invalidate,
		resubscribeOnWorktreeChange,
	]);

	return { refresh: doSubscribe };
}
