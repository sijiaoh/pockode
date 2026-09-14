import { useSettingsStore } from "../lib/settingsStore";
import type { ValueState } from "../lib/valueState";

/**
 * Whether the global settings snapshot is in, and what to do if it is not.
 *
 * One hook for all three call sites because they wait on one snapshot: a control
 * showing a resolved default before it arrives names a value the user never set
 * (`useGlobalEngine` resolves an unset agent to Claude, an unset mode to
 * Default), and a failed subscribe leaves it waiting forever — the socket stays
 * open, so nothing else on screen explains it and nothing retries on its own.
 */
export function useGlobalSettingsStatus(): {
	valueState: ValueState;
	error: string | null;
	refresh: (() => void) | null;
} {
	// Only whether a snapshot arrived, never whether its fields are filled in:
	// an empty snapshot is a real answer — the user set nothing — and the
	// resolved defaults are the honest thing to show for it.
	const hasSettings = useSettingsStore((s) => s.settings !== null);
	const error = useSettingsStore((s) => s.error);
	const refresh = useSettingsStore((s) => s.refresh);

	return {
		valueState: hasSettings ? "known" : error ? "unavailable" : "pending",
		error,
		refresh,
	};
}
