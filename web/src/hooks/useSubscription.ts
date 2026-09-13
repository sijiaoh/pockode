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
	 * Called when subscription succeeds. Receives initial data if provided by the server.
	 */
	onSubscribed?: (initial: TInitial) => void;
	/**
	 * Called when the subscription is torn down for good: on disable, disconnect,
	 * or a failed (re)subscribe. Clears data because it is no longer trustworthy.
	 */
	onReset?: () => void;
	/**
	 * Called at the start of a worktree switch instead of `onReset`.
	 * A switch is a soft refresh: the previous data is kept on screen and swapped
	 * out by `onSubscribed` once the new worktree's data arrives, avoiding a blank.
	 * Use this to mark the data as "reloading" without clearing it.
	 * If omitted, the data is simply retained during the switch.
	 */
	onWorktreeSwitch?: () => void;
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
 * Nothing is lost while a subscription is being opened: `subscribe` registers its
 * callback before the request goes out (see `openSubscription` in wsStore), and
 * this hook holds whatever arrives until the subscription's initial snapshot has
 * been applied. The contract in full: docs/code/subscription-system.md.
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
		onWorktreeSwitch,
		onError,
	} = options;
	const status = useWSStore((s) => s.status);
	const isConnected = status === "connected";
	const isReconnecting = status === "reconnecting";

	const onNotificationRef = useRef(onNotification);
	onNotificationRef.current = onNotification;

	const onSubscribedRef = useRef(onSubscribed);
	onSubscribedRef.current = onSubscribed;

	const onResetRef = useRef(onReset);
	onResetRef.current = onReset;

	const onWorktreeSwitchRef = useRef(onWorktreeSwitch);
	onWorktreeSwitchRef.current = onWorktreeSwitch;

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

		// Notifications that arrive before the subscription's own snapshot has been
		// applied. The server registers the subscription before it reads that
		// snapshot, and writes the reply and any notification from different
		// goroutines, so "changed" can reach us first. Delivered straight away it
		// would be overwritten by the older snapshot `onSubscribed` then applies;
		// dropped, the stale snapshot would stay on screen with nothing left to
		// correct it. Held and replayed in arrival order after the snapshot, the
		// data converges on what the server has: notifications are emitted in the
		// order the server's store committed the writes, so the last one is current.
		// Null once the snapshot is in and delivery is direct.
		let held: TNotification[] | null = [];

		try {
			const result = await subscribe((params) => {
				if (isStale()) return;
				if (held) {
					held.push(params);
					return;
				}
				onNotificationRef.current(params);
			});

			if (isStale()) {
				await unsubscribe(result.id);
				return;
			}

			subscriptionIdRef.current = result.id;

			// Delivery goes direct from here on, before the snapshot is applied
			// rather than after: nothing can arrive in between (a notification
			// reaches us from a socket event, which cannot interleave with the
			// synchronous call below), and a snapshot handler that throws must not
			// leave every later notification piling up in a queue nobody drains.
			const replay = held;
			held = null;

			if (onSubscribedRef.current) {
				onSubscribedRef.current(result.initial as TInitial);
			}

			for (const params of replay) {
				if (isStale()) return;
				onNotificationRef.current(params);
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
		// During reconnection, keep existing data without resetting
		if (isReconnecting) {
			invalidate();
			return;
		}

		if (!enabled || !isConnected) {
			invalidate();
			onResetRef.current?.();
			return;
		}

		doSubscribe();

		const cleanupSwitchStart = resubscribeOnWorktreeChange
			? worktreeActions.onWorktreeSwitchStart(() => {
					// Soft refresh: drop the old subscription but keep data on screen.
					// onSubscribed replaces it once the new worktree's data arrives.
					invalidate();
					onWorktreeSwitchRef.current?.();
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
		isReconnecting,
		doSubscribe,
		invalidate,
		resubscribeOnWorktreeChange,
	]);

	return { refresh: doSubscribe };
}
