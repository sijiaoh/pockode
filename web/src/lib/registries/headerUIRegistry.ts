import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";

export interface HeaderUIConfig {
	/**
	 * Custom Header component (replaces default header).
	 * Receives onOpenSidebar, onOpenSettings, title as props.
	 *
	 * Replaces the entire header, including the connection status indicator
	 * and the menu/settings buttons. Render `<ConnectionStatus />` from
	 * `components/ui` yourself if you want to keep it.
	 */
	HeaderContent?: ComponentType<HeaderContentProps>;

	/**
	 * Custom Title component (replaces default h1 title).
	 * No props - use hooks to get data.
	 */
	TitleComponent?: ComponentType;
}

export interface HeaderContentProps {
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	title?: string;
}

const defaultConfig: HeaderUIConfig = {};

let config: HeaderUIConfig = { ...defaultConfig };
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

function getSnapshot(): HeaderUIConfig {
	return config;
}

/**
 * @internal Use `ctx.headerUI.configure()` from extension context instead.
 */
export function setHeaderUIConfig(newConfig: Partial<HeaderUIConfig>): void {
	config = { ...config, ...newConfig };
	notifyListeners();
}

export function useHeaderUIConfig(): HeaderUIConfig {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * @internal For testing only.
 */
export function getHeaderUIConfig(): HeaderUIConfig {
	return config;
}

/**
 * @internal For testing only.
 */
export function resetHeaderUIConfig(): void {
	config = { ...defaultConfig };
	notifyListeners();
}
