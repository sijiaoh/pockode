import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { useSyncExternalStore } from "react";
import ShikiHighlighter from "react-shiki";
import { bundledLanguagesInfo } from "shiki";

// Build extension map from Shiki's bundled languages
const EXT_MAP: Record<string, string> = {};
for (const lang of bundledLanguagesInfo) {
	EXT_MAP[lang.id] = lang.id;
	if (lang.aliases) {
		for (const alias of lang.aliases) {
			EXT_MAP[alias] = lang.id;
		}
	}
}

/**
 * Infer language from file path for syntax highlighting.
 * Uses Shiki's bundled language definitions.
 */
export function getLanguageFromPath(path: string): string | undefined {
	const fileName = path.split("/").pop() ?? "";

	// Handle special filenames
	if (fileName.toLowerCase() === "dockerfile") return "docker";
	if (fileName.startsWith(".env")) return "shellscript";

	const ext = fileName.split(".").pop()?.toLowerCase();
	return ext ? EXT_MAP[ext] : undefined;
}

// Cache the highlighter instance globally
let highlighterPromise: ReturnType<typeof getDiffViewHighlighter> | null = null;

/**
 * Get cached diff view highlighter instance.
 */
export function getDiffHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = getDiffViewHighlighter();
	}
	return highlighterPromise;
}

// Dark mode detection via MutationObserver
export function subscribeToDarkMode(callback: () => void) {
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.attributeName === "class") {
				callback();
			}
		}
	});
	observer.observe(document.documentElement, { attributes: true });
	return () => observer.disconnect();
}

export function getIsDarkMode() {
	return document.documentElement.classList.contains("dark");
}

export function getShikiTheme() {
	return getIsDarkMode() ? "github-dark" : "github-light";
}

/** Code highlighter component with automatic dark/light theme switching */
export function CodeHighlighter({
	children,
	language,
}: {
	children: string;
	language?: string;
}) {
	const theme = useSyncExternalStore(subscribeToDarkMode, getShikiTheme);
	return (
		<ShikiHighlighter language={language} theme={theme}>
			{children}
		</ShikiHighlighter>
	);
}
