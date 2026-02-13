import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export const DEFAULT_PRIORITY = 100;

export interface SettingsSectionConfig {
	id: string;
	label: string;
	priority: number;
	component: ComponentType;
}

let sections: SettingsSectionConfig[] = [];
const listeners = new Set<() => void>();

function notifyListeners() {
	for (const listener of listeners) {
		listener();
	}
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
	return useSyncExternalStore(
		(callback) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		() => sections,
	);
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
export function resetSettingsSections() {
	sections = [];
	notifyListeners();
}
