import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import * as React from "react";
import { useShikiHighlighter } from "react-shiki";
import {
	type BundledLanguage,
	bundledLanguagesInfo,
	createCssVariablesTheme,
	createHighlighter,
	type Highlighter,
} from "shiki";
import { useIsDesktop } from "../hooks/useIsDesktop";

export const CODE_FONT_SIZE_MOBILE = 12;
export const CODE_FONT_SIZE_DESKTOP = 13;

const EXT_MAP: Record<string, string> = {};
for (const lang of bundledLanguagesInfo) {
	EXT_MAP[lang.id] = lang.id;
	if (lang.aliases) {
		for (const alias of lang.aliases) {
			EXT_MAP[alias] = lang.id;
		}
	}
}

export function getLanguageFromPath(path: string): string | undefined {
	const fileName = path.split("/").pop() ?? "";

	if (fileName.toLowerCase() === "dockerfile") return "docker";
	if (fileName.startsWith(".env")) return "shellscript";

	const ext = fileName.split(".").pop()?.toLowerCase();
	return ext ? EXT_MAP[ext] : undefined;
}

export function isMarkdownFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase();
	return ext === "md" || ext === "mdx";
}

let highlighterPromise: ReturnType<typeof getDiffViewHighlighter> | null = null;

export function getDiffHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = getDiffViewHighlighter();
	}
	return highlighterPromise;
}

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

const cssVarTheme = createCssVariablesTheme({
	name: "css-variables",
	variablePrefix: "--shiki-",
});

export function CodeHighlighter({
	children,
	language,
}: {
	children: string;
	language?: string;
}) {
	const isDesktop = useIsDesktop();
	const fontSize = isDesktop ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE;

	const highlighted = useShikiHighlighter(children, language, cssVarTheme);

	const style = { "--code-font-size": `${fontSize}px` } as React.CSSProperties;

	return (
		<pre className="code-block" style={style}>
			{highlighted ?? <code>{children}</code>}
		</pre>
	);
}

// Editor highlighter with useSyncExternalStore pattern
let editorHighlighter: Highlighter | null = null;
let editorHighlighterPromise: Promise<Highlighter> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notify() {
	version++;
	for (const listener of listeners) listener();
}

function getSnapshot() {
	return version;
}

async function ensureHighlighter(): Promise<Highlighter> {
	if (editorHighlighter) return editorHighlighter;
	if (!editorHighlighterPromise) {
		editorHighlighterPromise = createHighlighter({
			themes: [cssVarTheme],
			langs: [],
		}).then((hl) => {
			editorHighlighter = hl;
			notify();
			return hl;
		});
	}
	return editorHighlighterPromise;
}

async function ensureLanguage(language: string): Promise<void> {
	const hl = await ensureHighlighter();
	if (!hl.getLoadedLanguages().includes(language)) {
		try {
			await hl.loadLanguage(language as BundledLanguage);
			notify();
		} catch {
			// Language not supported
		}
	}
}

/**
 * Hook for syntax highlighting in an editor.
 * Returns a synchronous highlight function for use with react-simple-code-editor.
 */
export function useEditorHighlight(
	language?: string,
): (code: string) => string {
	React.useSyncExternalStore(subscribe, getSnapshot);

	React.useEffect(() => {
		if (language) ensureLanguage(language);
	}, [language]);

	return React.useCallback(
		(code: string) => {
			if (!editorHighlighter || !language) return escapeHtml(code);
			try {
				const html = editorHighlighter.codeToHtml(code, {
					lang: language,
					theme: "css-variables",
				});
				const match = html.match(/<code[^>]*>([\s\S]*)<\/code>/);
				return match?.[1] ?? escapeHtml(code);
			} catch {
				return escapeHtml(code);
			}
		},
		[language],
	);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
