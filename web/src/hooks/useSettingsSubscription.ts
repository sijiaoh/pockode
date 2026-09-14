import { useCallback, useEffect } from "react";
import { useSettingsStore } from "../lib/settingsStore";
import { useWSStore } from "../lib/wsStore";
import type { Settings, SettingsChangedNotification } from "../types/settings";
import { useSubscription } from "./useSubscription";

/**
 * Manages WebSocket subscription to settings.
 * Handles subscribe/unsubscribe lifecycle and notification processing.
 * Settings is global (not worktree-specific), so it doesn't resubscribe on worktree change.
 */
export function useSettingsSubscription(enabled: boolean) {
	const settingsSubscribe = useWSStore((s) => s.actions.settingsSubscribe);
	const settingsUnsubscribe = useWSStore((s) => s.actions.settingsUnsubscribe);

	const setSettings = useSettingsStore((s) => s.setSettings);
	const setError = useSettingsStore((s) => s.setError);
	const setRefresh = useSettingsStore((s) => s.setRefresh);
	const reset = useSettingsStore((s) => s.reset);

	const handleNotification = useCallback(
		(params: SettingsChangedNotification) => {
			setSettings(params.settings);
		},
		[setSettings],
	);

	// Without this the failure is indistinguishable from a snapshot still in
	// flight, and the controls waiting on one would pulse forever: the socket is
	// still open, so no banner appears and nothing resubscribes on its own.
	const handleError = useCallback(
		(err: unknown) => {
			// `String(err)` rather than a sentence of our own, as every other failure
			// in these panels does it: the reason is shown, and "Couldn't load
			// settings: Failed to load settings" would say nothing twice.
			setError(err instanceof Error ? err.message : String(err));
		},
		[setError],
	);

	const { refresh } = useSubscription<SettingsChangedNotification, Settings>(
		settingsSubscribe,
		settingsUnsubscribe,
		handleNotification,
		{
			enabled,
			resubscribeOnWorktreeChange: false,
			onSubscribed: setSettings,
			onReset: reset,
			onError: handleError,
		},
	);

	// Back to waiting the moment Retry is pressed, so a retry that fails the same
	// way reads as a retry that failed rather than as a button that does nothing:
	// the error line goes, the pulse comes back, and `handleError` returns it.
	const retry = useCallback(() => {
		reset();
		refresh();
	}, [reset, refresh]);

	// This hook is mounted at the top of the app; the Retry that calls it sits
	// beside each control that waits on the snapshot, too far to pass it to.
	useEffect(() => {
		setRefresh(retry);
		return () => setRefresh(null);
	}, [retry, setRefresh]);
}
