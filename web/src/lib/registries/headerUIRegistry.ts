import type { ComponentType, ReactNode } from "react";
import { useSyncExternalStore } from "react";

export interface HeaderUIConfig {
	/**
	 * Custom Header component (replaces default header).
	 * Receives onOpenSidebar, onOpenSettings, title and heading as props.
	 *
	 * Replaces the entire header, including the connection status indicator
	 * and the menu/settings buttons. Render `<ConnectionStatus />` from
	 * `components/ui` yourself if you want to keep it.
	 */
	HeaderContent?: ComponentType<HeaderContentProps>;

	/**
	 * Custom Title component: replaces the title's text, never the heading
	 * around it. In a chat that text is the open session's title, and sits
	 * inside the button that opens the session panel — so render phrasing
	 * content only (no heading, no button); the host draws the `h1`, the
	 * button and the engine/mode line beneath it. With no session open it is
	 * the project's name.
	 */
	TitleComponent?: ComponentType<TitleComponentProps>;
}

export interface HeaderContentProps {
	/** Absent when the sidebar is a persistent column: render no menu button. */
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	/** The open session's title, or the project's name when there is none. */
	title?: string;
	/**
	 * The session's own heading — its title and engine/mode line as the button
	 * that opens the session panel — and absent when no session is open.
	 * Render it: the session's engine, mode and facts are changed and read
	 * nowhere else, so a header that leaves it out leaves them unreachable.
	 */
	heading?: ReactNode;
}

export interface TitleComponentProps {
	/** The open session's title, or the project's name when there is none. */
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
