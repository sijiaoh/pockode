import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export interface SettingsSectionConfig {
	id: string;
	label: string;
	priority: number;
	// biome-ignore lint/suspicious/noExplicitAny: Section components may have various props
	component: ComponentType<{ id: string } & Record<string, any>>;
}

let sections: SettingsSectionConfig[] = [];
const listeners = new Set<() => void>();

function notifyListeners() {
	for (const listener of listeners) {
		listener();
	}
}

export function registerSettingsSection(
	config: SettingsSectionConfig,
): () => void {
	// Immutable update for React change detection
	sections = [...sections, config].sort((a, b) => a.priority - b.priority);
	notifyListeners();
	// Return unregister function
	return () => {
		sections = sections.filter((s) => s.id !== config.id);
		notifyListeners();
	};
}

// React hook with auto re-render on changes
export function useSettingsSections(): SettingsSectionConfig[] {
	return useSyncExternalStore(
		(callback) => {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
		() => sections,
	);
}

// For non-React use (initialization, etc.)
export function getSettingsSections(): SettingsSectionConfig[] {
	return sections;
}

// For testing
export function resetSettingsSections() {
	sections = [];
	notifyListeners();
}
