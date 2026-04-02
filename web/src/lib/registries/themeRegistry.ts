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
// These values must match the CSS custom properties in index.css.
// We duplicate them here because the theme preview needs to show colors
// for themes that aren't currently applied to the DOM.
export const THEME_INFO: Record<ThemeName, ThemeInfo> = {
	abyss: {
		label: "Abyss",
		description: "Ocean depths",
		accent: { light: "#0d9488", dark: "#2dd4bf" },
		bg: { light: "#f8fafb", dark: "#0c1220" },
		text: { light: "#0f172a", dark: "#f1f5f9" },
		textMuted: { light: "#64748b", dark: "#94a3b8" },
	},
	aurora: {
		label: "Aurora",
		description: "Northern lights",
		accent: { light: "#9333ea", dark: "#c084fc" },
		bg: { light: "#fbf9fe", dark: "#150a24" },
		text: { light: "#1e1030", dark: "#f5f3ff" },
		textMuted: { light: "#6b21a8", dark: "#a78bfa" },
	},
	ember: {
		label: "Ember",
		description: "Glowing coals",
		accent: { light: "#c2410c", dark: "#fb923c" },
		bg: { light: "#fefcfa", dark: "#1c1412" },
		text: { light: "#1c1412", dark: "#fef3e2" },
		textMuted: { light: "#9a3412", dark: "#fdba74" },
	},
	mint: {
		label: "Mint",
		description: "Cool breeze",
		accent: { light: "#0891b2", dark: "#22d3ee" },
		bg: { light: "#f8fcfa", dark: "#0a1610" },
		text: { light: "#083344", dark: "#ecfeff" },
		textMuted: { light: "#0e7490", dark: "#67e8f9" },
	},
	void: {
		label: "Void",
		description: "Pure simplicity",
		accent: { light: "#18181b", dark: "#fafafa" },
		bg: { light: "#ffffff", dark: "#09090b" },
		text: { light: "#09090b", dark: "#fafafa" },
		textMuted: { light: "#71717a", dark: "#a1a1aa" },
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
