import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeName = "slate" | "cyber" | "rose" | "grape";

export const THEME_NAMES: ThemeName[] = ["slate", "cyber", "rose", "grape"];

export const THEME_INFO: Record<
	ThemeName,
	{ label: string; description: string; accentColor: string }
> = {
	slate: {
		label: "Slate",
		description: "Classic & Professional",
		accentColor: "#6366f1", // indigo
	},
	cyber: {
		label: "Cyber",
		description: "Futuristic & Tech",
		accentColor: "#06b6d4", // cyan
	},
	rose: {
		label: "Rose",
		description: "Warm & Comfortable",
		accentColor: "#e11d48", // rose
	},
	grape: {
		label: "Grape",
		description: "Bold & Expressive",
		accentColor: "#8b5cf6", // violet
	},
};

const MODE_STORAGE_KEY = "theme-mode";
const NAME_STORAGE_KEY = "theme-name";

function getSystemTheme(): "light" | "dark" {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function applyTheme(mode: ThemeMode, name: ThemeName) {
	const root = document.documentElement;
	const resolvedMode = mode === "system" ? getSystemTheme() : mode;

	// Apply dark mode
	root.classList.toggle("dark", resolvedMode === "dark");

	// Remove all theme classes
	for (const themeName of THEME_NAMES) {
		root.classList.remove(`theme-${themeName}`);
	}

	// Apply theme class
	root.classList.add(`theme-${name}`);
}

export function useTheme() {
	const [mode, setModeState] = useState<ThemeMode>(() => {
		if (typeof window === "undefined") return "system";
		return (localStorage.getItem(MODE_STORAGE_KEY) as ThemeMode) || "system";
	});

	const [theme, setThemeState] = useState<ThemeName>(() => {
		if (typeof window === "undefined") return "slate";
		return (localStorage.getItem(NAME_STORAGE_KEY) as ThemeName) || "slate";
	});

	const setMode = useCallback(
		(newMode: ThemeMode) => {
			setModeState(newMode);
			localStorage.setItem(MODE_STORAGE_KEY, newMode);
			applyTheme(newMode, theme);
		},
		[theme],
	);

	const setTheme = useCallback(
		(newTheme: ThemeName) => {
			setThemeState(newTheme);
			localStorage.setItem(NAME_STORAGE_KEY, newTheme);
			applyTheme(mode, newTheme);
		},
		[mode],
	);

	// Apply theme on mount
	useEffect(() => {
		applyTheme(mode, theme);
	}, [mode, theme]);

	// Listen to system preference changes when in "system" mode
	useEffect(() => {
		if (mode !== "system") return;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handler = () => applyTheme("system", theme);

		mediaQuery.addEventListener("change", handler);
		return () => mediaQuery.removeEventListener("change", handler);
	}, [mode, theme]);

	const resolvedMode = mode === "system" ? getSystemTheme() : mode;

	return { mode, setMode, theme, setTheme, resolvedMode };
}
