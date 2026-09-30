import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export const DEFAULT_PRIORITY = 100;

export interface SettingsSectionConfig {
	id: string;
	label: string;
	priority: number;
	component: ComponentType;
	/**
	 * Whether the section applies right now. Hides the heading and its
	 * navigation entry with the body — a component returning null would leave
	 * both behind. Omitted means always shown.
	 */
	visibility?: SettingsSectionVisibility;
}

/**
 * A source the settings page can read and follow, in the shape
 * `useSyncExternalStore` takes — a zustand store's `getState` and `subscribe`
 * fit it directly. Not a hook: the page reads one per section, and hooks
 * cannot be called over a list whose length can change.
 */
export interface SettingsSectionVisibility {
	get: () => boolean;
	subscribe: (onChange: () => void) => () => void;
}

let sections: SettingsSectionConfig[] = [];
const listeners = new Set<() => void>();

function notifyListeners(): void {
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): SettingsSectionConfig[] {
	return sections;
}

/**
 * @internal Use `ctx.settings.register()` from extension context instead.
 */
export function registerSettingsSection(
	config: SettingsSectionConfig,
): () => void {
	sections = [...sections, config].sort((a, b) => a.priority - b.priority);
	notifyListeners();
	return () => {
		sections = sections.filter((s) => s.id !== config.id);
		notifyListeners();
	};
}

export function useSettingsSections(): SettingsSectionConfig[] {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * @internal For testing only.
 */
export function getSettingsSections(): SettingsSectionConfig[] {
	return sections;
}

/**
 * @internal For testing only.
 */
export function resetSettingsSections(): void {
	sections = [];
	notifyListeners();
}
