import { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { useIsExpanded } from "@pockode/shared";
import type { Element, ElementContent } from "hast";
import * as React from "react";
import { useShikiHighlighter } from "react-shiki";
import {
	type BundledLanguage,
	bundledLanguagesInfo,
	createCssVariablesTheme,
	createHighlighter,
	type Highlighter,
	type ShikiTransformer,
	type ThemedToken,
} from "shiki";
import { CopyButton } from "../components/ui/CopyButton";
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

const WORD = "code-word";
const SPACE_SPLIT = /(\s+)/;
/** The tab stop a `<pre>` uses unless told otherwise. */
const TAB_WIDTH = 8;

/**
 * How far a wrapped line's continuation is indented: 2ch past the line's own
 * indent, or nothing to set for an unindented line (index.css defaults
 * `--hang` to 2ch). An indented JSON key wrapped back to 2ch would read as a
 * shallower key.
 */
export function lineHang(line: string): string | undefined {
	const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
	if (!indent) return undefined;
	let width = 0;
	for (const char of indent) width += char === "\t" ? TAB_WIDTH : 1;
	return `${width + 2}ch`;
}

/** The single text a shiki token holds, or null for any other shape. */
function tokenText(token: ElementContent): string | null {
	if (token.type === "text") return token.value;
	if (
		token.type === "element" &&
		token.children.length === 1 &&
		token.children[0].type === "text"
	) {
		return token.children[0].value;
	}
	return null;
}

/**
 * A wrapped block's lines with every run of non-space characters held together
 * as one `.code-word`, so the browser breaks the line only between words.
 *
 * Left to itself it also breaks after a hyphen, and in a command that splits
 * `--reporter=verbose` into `--` and `reporter=verbose` — which read as two
 * arguments, on the one screen where the command is being audited before it is
 * approved. No CSS turns the hyphen's break off on its own; holding the word
 * together does, and a word too long for a whole line still breaks inside
 * itself (index.css, `.code-word`).
 *
 * Done on shiki's tree because its tokens do not follow words: `--reporter`
 * and `=verbose` may be two colours of one word. A token of any shape but one
 * text is kept whole as it came — shiki emits none today, and splitting one
 * would drop whatever is past its first child.
 */
export const wordWrapTransformer: ShikiTransformer = {
	name: "pockode:word-wrap",
	line(node) {
		const children: ElementContent[] = [];
		let word: Element | null = null;
		let lineText = "";
		for (const token of node.children) {
			const text = tokenText(token);
			if (text === null) {
				word = null;
				children.push(token);
				continue;
			}
			lineText += text;
			for (const piece of text.split(SPACE_SPLIT)) {
				if (!piece) continue;
				if (/^\s/.test(piece)) {
					word = null;
					children.push({ type: "text", value: piece });
					continue;
				}
				if (!word) {
					word = {
						type: "element",
						tagName: "span",
						properties: { class: WORD },
						children: [],
					};
					children.push(word);
				}
				word.children.push(
					token.type === "element"
						? { ...token, children: [{ type: "text", value: piece }] }
						: { type: "text", value: piece },
				);
			}
		}
		node.children = children;
		const hang = lineHang(lineText);
		if (hang) node.properties.style = `--hang:${hang}`;
	},
	// The lines are blocks in a wrapped block (index.css), so the newline shiki
	// puts between them would be a blank line of its own — and so would the
	// empty line after a final newline, which a `<pre>` used to swallow.
	code(node) {
		const children = node.children.filter(
			(child) => !(child.type === "text" && child.value === "\n"),
		);
		const last = children[children.length - 1];
		if (last?.type === "element" && last.children.length === 0) children.pop();
		node.children = children;
	},
};

const WRAP_OPTIONS = { transformers: [wordWrapTransformer] };

/**
 * The tree `wordWrapTransformer` builds, for text shiki has not seen — before
 * it answers, or past the size it is allowed. The same shape, so a block does
 * not change height the moment its colours arrive.
 *
 * Without `words` the lines are left unsplit: text past the size shiki is
 * allowed is withheld from it to spare the main thread, and a span per word of
 * it would spend that saving on the DOM instead.
 */
export function WrappedPlain({
	text,
	words = true,
}: {
	text: string;
	words?: boolean;
}) {
	return (
		<code>
			{text
				.replace(/\n$/, "")
				.split("\n")
				.map((line, lineIndex) => {
					const hang = lineHang(line);
					return (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: the lines of one fixed string
							key={lineIndex}
							className="line"
							style={
								hang ? ({ "--hang": hang } as React.CSSProperties) : undefined
							}
						>
							{words
								? line.split(SPACE_SPLIT).map((piece, index) =>
										index % 2 === 1 ? (
											piece
										) : piece ? (
											// biome-ignore lint/suspicious/noArrayIndexKey: as above
											<span key={index} className={WORD}>
												{piece}
											</span>
										) : null,
									)
								: line}
						</span>
					);
				})}
		</code>
	);
}

export function CodeHighlighter({
	children,
	language,
	plain = false,
	wrap = false,
	copyable = true,
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
	/**
	 * Lay a copy button over the corner. Off where the block sits under a
	 * `BlockHeader` that carries one, which is the place that covers nothing.
	 */
	copyable?: boolean;
}) {
	const isExpanded = useIsExpanded();
	const fontSize = isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE;

	// Highlighting is synchronous CPU work proportional to the input, and awaiting
	// it does not spare the main thread — so the oversized input is withheld from
	// shiki rather than merely having its result discarded.
	const highlighted = useShikiHighlighter(
		plain ? "" : children,
		plain ? undefined : language,
		cssVarTheme,
		wrap ? WRAP_OPTIONS : undefined,
	);

	const style = { "--code-font-size": `${fontSize}px` } as React.CSSProperties;
	const preClass = wrap
		? copyable
			? "code-block code-block--wrap code-block--corner"
			: "code-block code-block--wrap"
		: "code-block";

	return (
		<div className="code-block-wrapper">
			{copyable && (
				<CopyButton
					text={children}
					label="Copy code"
					className="code-copy-button"
				/>
			)}
			<pre className={preClass} style={style}>
				{(!plain && highlighted) ||
					(wrap ? (
						<WrappedPlain text={children} words={!plain} />
					) : (
						<code>{children}</code>
					))}
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
 * Code's colours as tokens per line, for a view that draws its lines itself —
 * the full screen viewer's, which draws only the lines in view. Over the whole
 * text at once, because a line's colours depend on the lines before it (an
 * open comment). Null for a language shiki does not know.
 */
export async function highlightLines(
	code: string,
	language: string,
): Promise<ThemedToken[][] | null> {
	await ensureLanguage(language);
	const hl = await ensureHighlighter();
	if (!hl.getLoadedLanguages().includes(language)) return null;
	return hl.codeToTokens(code, {
		lang: language as BundledLanguage,
		theme: cssVarTheme.name ?? "css-variables",
	}).tokens;
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
