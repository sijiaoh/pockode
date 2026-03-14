import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export interface SidebarUIConfig {
	/**
	 * Custom SidebarContent component (replaces default tabs + content).
	 * No props - use hooks (useSession, useRouteState, useSidebarContainer) to get data.
	 */
	SidebarContent?: ComponentType;
}

const defaultConfig: SidebarUIConfig = {};

let config: SidebarUIConfig = { ...defaultConfig };
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

function getSnapshot(): SidebarUIConfig {
	return config;
}

/**
 * @internal Use `ctx.sidebarUI.configure()` from extension context instead.
 */
export function setSidebarUIConfig(newConfig: Partial<SidebarUIConfig>): void {
	config = { ...config, ...newConfig };
	notifyListeners();
}

export function useSidebarUIConfig(): SidebarUIConfig {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * @internal For testing only.
 */
export function getSidebarUIConfig(): SidebarUIConfig {
	return config;
}

/**
 * @internal For testing only.
 */
export function resetSidebarUIConfig(): void {
	config = { ...defaultConfig };
	notifyListeners();
}
