import { useSyncExternalStore } from "react";
import { create } from "zustand";

const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_NAMES = [
	"abyss",
	"aurora",
	"ember",
	"mint",
	"void",
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

function isValidThemeMode(value: string | null): value is ThemeMode {
	return value !== null && THEME_MODES.includes(value as ThemeMode);
}

function isValidThemeName(value: string | null): value is ThemeName {
	return value !== null && THEME_NAMES.includes(value as ThemeName);
}

// Theme colors for preview display.
// These values must match the CSS custom properties in index.css.
// We duplicate them here because the theme preview needs to show colors
// for themes that aren't currently applied to the DOM.
export interface ThemeInfo {
	label: string;
	description: string;
	accent: { light: string; dark: string };
	bg: { light: string; dark: string };
	text: { light: string; dark: string };
	textMuted: { light: string; dark: string };
}

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

const MODE_STORAGE_KEY = "theme-mode";
const NAME_STORAGE_KEY = "theme-name";

function getSystemTheme(): "light" | "dark" {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
	return mode === "system" ? getSystemTheme() : mode;
}

function applyThemeToDOM(mode: ThemeMode, name: string) {
	const root = document.documentElement;
	const resolved = resolveMode(mode);

	root.classList.toggle("dark", resolved === "dark");

	// Remove all theme classes (builtin and custom)
	for (const themeName of THEME_NAMES) {
		root.classList.remove(`theme-${themeName}`);
	}
	for (const themeName of customThemes.keys()) {
		root.classList.remove(`theme-${themeName}`);
	}
	root.classList.add(`theme-${name}`);
}

interface ThemeState {
	mode: ThemeMode;
	theme: ThemeName;
	resolvedMode: "light" | "dark";
}

function getInitialMode(): ThemeMode {
	const stored = localStorage.getItem(MODE_STORAGE_KEY);
	return isValidThemeMode(stored) ? stored : "system";
}

function getInitialTheme(): ThemeName {
	const stored = localStorage.getItem(NAME_STORAGE_KEY);
	return isValidThemeName(stored) ? stored : "abyss";
}

const initialMode = getInitialMode();

export const useThemeStore = create<ThemeState>(() => ({
	mode: initialMode,
	theme: getInitialTheme(),
	resolvedMode: resolveMode(initialMode),
}));

export const themeActions = {
	setMode: (newMode: ThemeMode) => {
		const { theme } = useThemeStore.getState();
		localStorage.setItem(MODE_STORAGE_KEY, newMode);
		applyThemeToDOM(newMode, theme);
		useThemeStore.setState({
			mode: newMode,
			resolvedMode: resolveMode(newMode),
		});
	},

	setTheme: (newTheme: string) => {
		if (!isValidTheme(newTheme)) {
			console.warn(`Invalid theme: ${newTheme}`);
			return;
		}
		const { mode } = useThemeStore.getState();
		localStorage.setItem(NAME_STORAGE_KEY, newTheme);
		applyThemeToDOM(mode, newTheme);
		useThemeStore.setState({ theme: newTheme as ThemeName });
	},

	init: () => {
		const { mode, theme } = useThemeStore.getState();
		applyThemeToDOM(mode, theme);

		// Listen to system preference changes (called once at app startup, no cleanup needed)
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		mediaQuery.addEventListener("change", () => {
			const { mode: currentMode, theme: currentTheme } =
				useThemeStore.getState();
			if (currentMode === "system") {
				applyThemeToDOM("system", currentTheme);
				useThemeStore.setState({ resolvedMode: getSystemTheme() });
			}
		});
	},
};

export function useTheme() {
	const state = useThemeStore();
	return {
		...state,
		setMode: themeActions.setMode,
		setTheme: themeActions.setTheme,
	};
}

// ============================================
// Custom Theme Extension API
// ============================================

let customThemes = new Map<string, ThemeInfo>();
const themeListeners = new Set<() => void>();

function notifyThemeListeners() {
	allThemesCache = null;
	for (const listener of themeListeners) {
		listener();
	}
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
	return useSyncExternalStore((callback) => {
		themeListeners.add(callback);
		return () => themeListeners.delete(callback);
	}, getAllThemesSnapshot);
}

/**
 * Get all themes (builtin + custom) for non-React use.
 */
export function getAllThemes(): Array<{ name: string; info: ThemeInfo }> {
	return getAllThemesSnapshot();
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
