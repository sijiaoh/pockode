import { useSyncExternalStore } from "react";

export const THEME_NAMES = [
	"abyss",
	"aurora",
	"ember",
	"mint",
	"void",
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export interface ThemeInfo {
	label: string;
	description: string;
	accent: { light: string; dark: string };
	bg: { light: string; dark: string };
	text: { light: string; dark: string };
	textMuted: { light: string; dark: string };
}

// Theme colors for preview display.
// We duplicate them here because the theme preview needs to show colors
// for themes that aren't currently applied to the DOM.
// Every value is a copy of a custom property in index.css — accent
// `--th-accent`, bg `--th-bg-primary`, text `--th-text-primary`, textMuted
// `--th-text-muted` — and index.css is the source of truth for all of them.
// tests/themeTokens.test.ts compares the two, themes included, so edit the
// stylesheet and let the failure tell you what to copy here.
export const THEME_INFO: Record<ThemeName, ThemeInfo> = {
	abyss: {
		label: "Abyss",
		description: "Ocean depths",
		accent: { light: "#0b7a70", dark: "#2dd4bf" },
		bg: { light: "#f8fafb", dark: "#0c1220" },
		text: { light: "#0c1829", dark: "#e8f0f5" },
		textMuted: { light: "#7c919e", dark: "#5a7a8f" },
	},
	aurora: {
		label: "Aurora",
		description: "Northern lights",
		accent: { light: "#9333ea", dark: "#c084fc" },
		bg: { light: "#fbf9fe", dark: "#150a24" },
		text: { light: "#1e1228", dark: "#f3e8ff" },
		textMuted: { light: "#6d5d80", dark: "#7c5a9c" },
	},
	ember: {
		label: "Ember",
		description: "Glowing coals",
		accent: { light: "#c2410c", dark: "#fb923c" },
		bg: { light: "#fefcfa", dark: "#1c1412" },
		text: { light: "#27201c", dark: "#f8f0e8" },
		textMuted: { light: "#7a6a5c", dark: "#8a7468" },
	},
	mint: {
		label: "Mint",
		description: "Cool breeze",
		accent: { light: "#077691", dark: "#22d3ee" },
		bg: { light: "#f8fcfa", dark: "#0a1610" },
		text: { light: "#0a2018", dark: "#e8f8f0" },
		textMuted: { light: "#4a7560", dark: "#5a8a70" },
	},
	void: {
		label: "Void",
		description: "Pure simplicity",
		accent: { light: "#18181b", dark: "#fafafa" },
		bg: { light: "#ffffff", dark: "#09090b" },
		text: { light: "#09090b", dark: "#fafafa" },
		textMuted: { light: "#a1a1aa", dark: "#71717a" },
	},
};

// ============================================
// Custom Theme Registry
// ============================================

let customThemes = new Map<string, ThemeInfo>();
const themeListeners = new Set<() => void>();

function notifyThemeListeners() {
	allThemesCache = null;
	for (const listener of themeListeners) {
		listener();
	}
}

function subscribe(listener: () => void): () => void {
	themeListeners.add(listener);
	return () => themeListeners.delete(listener);
}

/**
 * Subscribe to theme registry changes (custom theme add/remove).
 * @returns Unsubscribe function.
 */
export const subscribeThemeRegistry = subscribe;

function injectThemeCSS(name: string, css: string) {
	const styleId = `theme-${name}`;
	let style = document.getElementById(styleId) as HTMLStyleElement | null;
	if (!style) {
		style = document.createElement("style");
		style.id = styleId;
		document.head.appendChild(style);
	}
	style.textContent = css;
}

function removeThemeCSS(name: string) {
	const style = document.getElementById(`theme-${name}`);
	if (style) {
		style.remove();
	}
}

/**
 * Register a custom theme at runtime.
 * The CSS should define `.theme-{name}` class with theme variables.
 *
 * @internal Use `ctx.theme.register()` from extension context instead.
 * @returns Unregister function that removes the theme.
 */
export function registerTheme(
	name: string,
	info: ThemeInfo,
	css: string,
): () => void {
	if (THEME_NAMES.includes(name as ThemeName)) {
		console.warn(`Theme "${name}" conflicts with a builtin theme, ignoring`);
		return () => {};
	}

	if (customThemes.has(name)) {
		console.warn(`Theme "${name}" is already registered, overwriting`);
	}

	// Immutable update for React change detection
	customThemes = new Map(customThemes);
	customThemes.set(name, info);
	injectThemeCSS(name, css);
	notifyThemeListeners();

	return () => {
		customThemes = new Map(customThemes);
		customThemes.delete(name);
		removeThemeCSS(name);
		notifyThemeListeners();
	};
}

let allThemesCache: Array<{ name: string; info: ThemeInfo }> | null = null;

function getAllThemesSnapshot(): Array<{ name: string; info: ThemeInfo }> {
	if (allThemesCache === null) {
		const builtin = THEME_NAMES.map((name) => ({
			name,
			info: THEME_INFO[name],
		}));
		const custom = Array.from(customThemes.entries()).map(([name, info]) => ({
			name,
			info,
		}));
		allThemesCache = [...builtin, ...custom];
	}
	return allThemesCache;
}

/**
 * React hook to get all themes (builtin + custom).
 * Auto re-renders when custom themes are added.
 */
export function useAllThemes(): Array<{ name: string; info: ThemeInfo }> {
	return useSyncExternalStore(
		subscribe,
		getAllThemesSnapshot,
		getAllThemesSnapshot,
	);
}

/**
 * Get all themes (builtin + custom) for non-React use.
 */
export function getAllThemes(): Array<{ name: string; info: ThemeInfo }> {
	return getAllThemesSnapshot();
}

/**
 * Get custom theme names for DOM class management.
 */
export function getCustomThemeNames(): IterableIterator<string> {
	return customThemes.keys();
}

/**
 * Check if a theme name is valid (builtin or custom).
 */
export function isValidTheme(name: string): boolean {
	return THEME_NAMES.includes(name as ThemeName) || customThemes.has(name);
}

/**
 * Get theme info by name (builtin or custom).
 */
export function getThemeInfo(name: string): ThemeInfo | undefined {
	if (THEME_NAMES.includes(name as ThemeName)) {
		return THEME_INFO[name as ThemeName];
	}
	return customThemes.get(name);
}

/**
 * @internal For testing only.
 */
export function resetCustomThemes(): void {
	for (const name of customThemes.keys()) {
		removeThemeCSS(name);
	}
	customThemes = new Map();
	notifyThemeListeners();
}
