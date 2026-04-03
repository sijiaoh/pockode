import { create } from "zustand";
import {
	getCustomThemeNames,
	isValidTheme,
	subscribeThemeRegistry,
	THEME_NAMES,
	type ThemeName,
} from "./registries/themeRegistry";

const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

function isValidThemeMode(value: string | null): value is ThemeMode {
	return value !== null && THEME_MODES.includes(value as ThemeMode);
}

function isBuiltinThemeName(value: string | null): value is ThemeName {
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
	return isBuiltinThemeName(stored) ? stored : "abyss";
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

	init: (() => {
		let initialized = false;

		return () => {
			if (initialized) return;
			initialized = true;

			const { mode, theme } = useThemeStore.getState();
			applyThemeToDOM(mode, theme);

			const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
			mediaQuery.addEventListener("change", () => {
				const { mode: currentMode, theme: currentTheme } =
					useThemeStore.getState();
				if (currentMode === "system") {
					applyThemeToDOM("system", currentTheme);
					useThemeStore.setState({ resolvedMode: getSystemTheme() });
				}
			});

			// Sync store with registry changes (theme added/removed)
			subscribeThemeRegistry(() => {
				const { theme: current, mode } = useThemeStore.getState();
				const stored = localStorage.getItem(NAME_STORAGE_KEY);

				// Restore custom theme from localStorage after extension registers it
				if (stored && stored !== current && isValidTheme(stored)) {
					applyThemeToDOM(mode, stored);
					useThemeStore.setState({ theme: stored });
					return;
				}

				// Fall back to default if active theme was unregistered
				if (!isValidTheme(current)) {
					const fallback: ThemeName = "abyss";
					// Remove stale class — applyThemeToDOM won't find it
					// since it's already gone from the registry
					document.documentElement.classList.remove(`theme-${current}`);
					localStorage.setItem(NAME_STORAGE_KEY, fallback);
					applyThemeToDOM(mode, fallback);
					useThemeStore.setState({ theme: fallback });
				}
			});
		};
	})(),
};

export function useTheme() {
	const state = useThemeStore();
	return {
		...state,
		setMode: themeActions.setMode,
		setTheme: themeActions.setTheme,
	};
}
