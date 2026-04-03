import { create } from "zustand";
import {
	getCustomThemeNames,
	isValidTheme,
	THEME_NAMES,
	type ThemeName,
} from "./registries/themeRegistry";

const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

function isValidThemeMode(value: string | null): value is ThemeMode {
	return value !== null && THEME_MODES.includes(value as ThemeMode);
}

function isValidThemeName(value: string | null): value is ThemeName {
	return value !== null && THEME_NAMES.includes(value as ThemeName);
}

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
	for (const themeName of getCustomThemeNames()) {
		root.classList.remove(`theme-${themeName}`);
	}
	root.classList.add(`theme-${name}`);
}

interface ThemeState {
	mode: ThemeMode;
	/** Builtin ThemeName or custom theme name registered via extensions. */
	theme: string;
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
		useThemeStore.setState({ theme: newTheme });
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
