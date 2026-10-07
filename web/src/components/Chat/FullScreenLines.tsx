import { useHasCoarsePointer } from "@pockode/shared";
import { AnsiUp } from "ansi_up";
import {
	type CSSProperties,
	type Ref,
	type RefObject,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { ThemedToken } from "shiki";
import type { FullScreenContent } from "../../lib/fullScreen";
import { highlightLines, lineHang } from "../../lib/shikiUtils";
import { outputLines } from "../../lib/textLines";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import {
	ERROR_TAIL_LINES,
	FAILURE_TEXT,
	FilePathRow,
} from "./ToolResultDisplay";
import { VirtualLines, type VirtualLinesHandle } from "./VirtualLines";

/** A `text-xs` row, which is 1rem tall. */
const ROW_HEIGHT = 16;
/** The tab stop a `<pre>` uses unless told otherwise. */
const TAB_WIDTH = 8;

/** Characters a mono font draws two columns wide: CJK, Hangul, emoji. */
const WIDE =
	/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range, tab included
const ASCII = /^[\x00-\x7F]*$/;

/** A line's width in `ch`: tabs at their widest, wide characters as two. */
function lineColumns(line: string): number {
	if (ASCII.test(line)) {
		let width = line.length;
		for (let i = line.indexOf("\t"); i !== -1; i = line.indexOf("\t", i + 1)) {
			width += TAB_WIDTH - 1;
		}
		return width;
	}
	let width = 0;
	for (const char of line) {
		width += char === "\t" ? TAB_WIDTH : WIDE.test(char) ? 2 : 1;
	}
	return width;
}

/** The longest line's width in `ch`. */
function columnsOf(lines: string[]): number {
	let widest = 0;
	for (const line of lines) widest = Math.max(widest, lineColumns(line));
	return widest;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#x27;": "'",
};

/** The text `ansi_up`'s HTML shows: its tags dropped, its escapes undone. */
function htmlText(html: string): string {
	return html
		.replace(/<[^>]*>/g, "")
		.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);
}

/**
 * Output's lines, coloured. A fresh `AnsiUp` per output, fed a line at a time:
 * it carries a colour left on across lines, which a parser per line would
 * drop — and one shared with the transcript would leak from one output into
 * the next. The plain text is that same parse's, so a position in it is a
 * position in what is drawn: `ansi_up` also eats sequences (OSC 8 links) a
 * simple escape pattern leaves in.
 *
 * Each line is fed with its newline, which is what ends a sequence the output
 * broke off: without it `ansi_up` holds the rest of the output as the
 * sequence's own. The newline itself is no part of a row.
 */
export function parseOutput(text: string): { html: string[]; text: string[] } {
	const ansi = new AnsiUp();
	ansi.use_classes = true;
	const html = outputLines(text).map((line) =>
		ansi.ansi_to_html(`${line}\n`).replaceAll("\n", ""),
	);
	return { html, text: html.map(htmlText) };
}

interface LinesProps {
	scrollerRef: RefObject<HTMLElement | null>;
	wrap: boolean;
	ref?: Ref<VirtualLinesHandle>;
}

export function OutputLines({
	content,
	parsed,
	fromEnd,
	...props
}: LinesProps & {
	content: Extract<FullScreenContent, { kind: "output" }>;
	/** `parseOutput` of the content's text, which find searches too. */
	parsed: ReturnType<typeof parseOutput>;
	fromEnd: boolean;
}) {
	const columns = useMemo(() => columnsOf(parsed.text), [parsed]);
	// A failed command says why in its last lines, as in the transcript.
	const failedFrom = content.failedTail
		? parsed.html.length - ERROR_TAIL_LINES
		: parsed.html.length;

	return (
		<>
			{Boolean(content.live?.droppedLines) && (
				<p className="pb-1 text-th-text-muted">
					Earlier output arrives with the result
				</p>
			)}
			<VirtualLines
				{...props}
				count={parsed.html.length}
				lines={parsed}
				firstLine={content.live?.droppedLines}
				estimateRowHeight={ROW_HEIGHT}
				columns={columns}
				fromEnd={fromEnd}
				className="font-mono text-th-text-muted"
				renderRow={(index) => (
					<div
						className={index >= failedFrom ? FAILURE_TEXT : undefined}
						// biome-ignore lint/security/noDangerouslySetInnerHtml: ansi_up escapes the text it is given
						dangerouslySetInnerHTML={{ __html: parsed.html[index] }}
					/>
				)}
			/>
		</>
	);
}

/** shiki's `FontStyle` flags. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

function tokenStyle(token: ThemedToken): CSSProperties {
	const flags = token.fontStyle ?? 0;
	return {
		color: token.color,
		fontStyle: flags & ITALIC ? "italic" : undefined,
		fontWeight: flags & BOLD ? "bold" : undefined,
		textDecoration: flags & UNDERLINE ? "underline" : undefined,
	};
}

/**
 * Code, coloured once over the whole text and drawn by the line. Plain until
 * the colours arrive, and past `HIGHLIGHT_LIMIT` for good — the ceiling the
 * rest of the app uses, since shiki tokenizes on the main thread.
 */
export function CodeLines({
	content,
	lines,
	wrap,
	...props
}: LinesProps & {
	content: Extract<FullScreenContent, { kind: "code" }>;
	/** `outputLines` of the content's text, which find searches too. */
	lines: string[];
}) {
	const { text, language } = content;
	const columns = useMemo(() => columnsOf(lines), [lines]);
	const [highlighted, setHighlighted] = useState<{
		text: string;
		tokens: ThemedToken[][];
	} | null>(null);

	useEffect(() => {
		if (!language || text.length > HIGHLIGHT_LIMIT) return;
		let current = true;
		highlightLines(text, language).then(
			(tokens) => {
				if (current && tokens) setHighlighted({ text, tokens });
			},
			// Uncoloured code is still the code; a highlighter that failed to
			// load costs only its colours.
			() => {},
		);
		return () => {
			current = false;
		};
	}, [text, language]);

	const tokens = highlighted?.text === text ? highlighted.tokens : null;

	return (
		<VirtualLines
			{...props}
			wrap={wrap}
			count={lines.length}
			lines={lines}
			estimateRowHeight={ROW_HEIGHT}
			columns={columns}
			fromEnd={false}
			className="font-mono [color:var(--shiki-foreground)]"
			renderRow={(index) => {
				const line = tokens?.[index];
				const body = line
					? line.map((token, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a line's tokens are fixed
							<span key={i} style={tokenStyle(token)}>
								{token.content}
							</span>
						))
					: lines[index];
				if (!wrap) return body;
				// A wrapped line's continuation hangs past its indent, as the
				// transcript's wrapped code does.
				const hang = lineHang(lines[index]);
				return (
					<div
						className="pl-[var(--hang,2ch)] -indent-[var(--hang,2ch)]"
						style={hang ? ({ "--hang": hang } as CSSProperties) : undefined}
					>
						{body}
					</div>
				);
			}}
		/>
	);
}

/** Every path, a row each, each offering the way over to the Files tab. */
export function FileLines({
	content,
	onOpenFile,
	...props
}: Omit<LinesProps, "wrap"> & {
	content: Extract<FullScreenContent, { kind: "files" }>;
	onOpenFile?: (path: string) => void;
}) {
	const coarse = useHasCoarsePointer();
	return (
		<VirtualLines
			{...props}
			wrap
			count={content.paths.length}
			lines={content.paths}
			// The Open button's height, and the 2px between rows.
			estimateRowHeight={(coarse ? 44 : 36) + 2}
			columns={0}
			fromEnd={false}
			renderRow={(index) => (
				<div className="pb-0.5">
					<FilePathRow path={content.paths[index]} onOpenFile={onOpenFile} />
				</div>
			)}
		/>
	);
}
