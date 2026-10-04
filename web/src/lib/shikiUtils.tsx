import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { useIsExpanded } from "@pockode/shared";
import { Check, Copy, X } from "lucide-react";
import * as React from "react";
import { useShikiHighlighter } from "react-shiki";
import {
	type BundledLanguage,
	bundledLanguagesInfo,
	createCssVariablesTheme,
	createHighlighter,
	type Highlighter,
} from "shiki";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { splitNativePath } from "../utils/path";

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
	// Callers pass both kinds of path: a tool result's native `file_path` (which
	// is backslash-separated on Windows) and a slash-separated path from
	// Pockode's own API. Splitting on either separator is correct for both.
	const fileName = splitNativePath(path).pop() ?? "";

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
	plain = false,
	wrap = false,
}: {
	children: string;
	language?: string;
	/** Render the code as-is. Use for input too large to tokenize on the main thread. */
	plain?: boolean;
	/**
	 * Break long lines instead of scrolling them. For text read end to end —
	 * a command being approved — not for code whose lines have to stay aligned.
	 */
	wrap?: boolean;
}) {
	const isExpanded = useIsExpanded();
	const fontSize = isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE;
	const { state: copyState, copy } = useCopyToClipboard({
		resetAfterMs: 2000,
	});

	// Highlighting is synchronous CPU work proportional to the input, and awaiting
	// it does not spare the main thread — so the oversized input is withheld from
	// shiki rather than merely having its result discarded.
	const highlighted = useShikiHighlighter(
		plain ? "" : children,
		plain ? undefined : language,
		cssVarTheme,
	);

	const style = { "--code-font-size": `${fontSize}px` } as React.CSSProperties;

	return (
		<div className="code-block-wrapper">
			<button
				type="button"
				onClick={() => copy(children)}
				className="code-copy-button touch-target"
				// A failed copy needs nothing more: the code is on screen in full.
				aria-label={
					copyState === "copied"
						? "Copied"
						: copyState === "failed"
							? "Copy failed"
							: "Copy code"
				}
			>
				{copyState === "copied" ? (
					<Check size={14} />
				) : copyState === "failed" ? (
					<X size={14} />
				) : (
					<Copy size={14} />
				)}
			</button>
			<pre
				className={wrap ? "code-block code-block--wrap" : "code-block"}
				style={style}
			>
				{plain ? (
					<code>{children}</code>
				) : (
					(highlighted ?? <code>{children}</code>)
				)}
			</pre>
		</div>
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
