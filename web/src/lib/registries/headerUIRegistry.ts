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
	 * Custom Title component: replaces the text of a name — the open session's
	 * or the project's — never the heading around it, and never a page's title
	 * (a file, a commit, ...), which is the page's own. In a chat the text sits
	 * inside the button that opens the session panel, so render phrasing
	 * content only (no heading, no button); the host draws the `h1`, the button
	 * and the engine/mode line beneath it. With no session open it is the
	 * project's name.
	 */
	TitleComponent?: ComponentType<TitleComponentProps>;
}

export interface HeaderContentProps {
	/** Absent when the sidebar is a persistent column: render no menu button. */
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	/**
	 * The open session's title in a chat; the project's name with no session
	 * open, and over a page, which is not about the session behind it.
	 */
	title?: string;
	/**
	 * The heading of whatever is on screen, ready to render, and absent when
	 * there is nothing more to say than `title`:
	 * - in a chat, the session's title and engine/mode line as the button that
	 *   opens the session panel — the one place the session's engine, mode and
	 *   facts are read and changed;
	 * - over a page (a diff, a file, a commit, ...), the page's way back and its
	 *   title — the one way back to the chat, the menu aside.
	 *
	 * Render it, wherever the header puts its title: it changes with the page,
	 * so a header that draws it follows every page without knowing any of them,
	 * and one that leaves it out leaves the above unreachable. It owns its `h1`
	 * and lays itself out in a row, so give it the room a title would get.
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
