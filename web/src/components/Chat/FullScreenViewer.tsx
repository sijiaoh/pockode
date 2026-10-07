import { ChevronDown, Search } from "lucide-react";
import {
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useBackToClose } from "../../hooks/useBackToClose";
import type {
	FullScreenContent,
	FullScreenSource,
	FullScreenSubject,
} from "../../lib/fullScreen";
import { contentCount, formatCount } from "../../lib/hugeContent";
import { outputLines } from "../../lib/textLines";
import { pathParts } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { formatFilePath } from "../../utils/path";
import {
	HeaderCopyButton,
	headerButtonClass,
	MarkdownContent,
	Sheet,
	WrapLinesToggle,
} from "../ui";
import {
	composing,
	diffSegments,
	FindBar,
	type FindModel,
	markdownSegments,
} from "./FullScreenFind";
import {
	CodeLines,
	FileLines,
	OutputLines,
	parseOutput,
} from "./FullScreenLines";
import {
	changeHasDiffs,
	DiffWrapToggle,
	ProposedChange,
} from "./ProposedChange";
import { Detail } from "./ToolRow";
import type { VirtualLinesHandle } from "./VirtualLines";

/**
 * What the tool acted on: one truncated line that opens onto the whole of it.
 *
 * The whole text goes below the line rather than into it, because text inside
 * a button cannot be selected on a touch screen, and a command is copied out
 * of here as often as it is read.
 */
function SubjectLine({ subject }: { subject: FullScreenSubject }) {
	const workDir = useWSStore((state) => state.workDir);
	const [open, setOpen] = useState(false);
	const id = useId();
	const full = subject.kind === "path" ? subject.path : subject.text;

	return (
		<>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen(!open)}
				className="touch-target flex min-w-0 max-w-full items-center gap-1 rounded text-left text-xs text-th-text-muted hover:text-th-text-primary"
			>
				{subject.kind === "path" ? (
					// Cut from the left, as the transcript's path line is, so the file
					// name survives.
					<Detail {...detailOf(pathParts(subject.path, workDir))} mono />
				) : (
					<span className="min-w-0 truncate font-mono">{subject.text}</span>
				)}
				<ChevronDown
					className={`size-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
					aria-hidden="true"
				/>
			</button>
			<pre
				id={id}
				hidden={!open}
				className="mt-1 max-h-[40dvh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-th-text-primary"
			>
				{full}
			</pre>
		</>
	);
}

function detailOf({ head, tail }: { head: string; tail: string }) {
	return { detail: head, detailTail: tail };
}

/**
 * The text of content drawn by the line — what is drawn, and what find
 * searches, from one parse.
 */
interface ContentLines {
	/** Output's lines, coloured and plain. */
	parsed: ReturnType<typeof parseOutput> | null;
	/** The plain text of each drawn row. */
	lines: string[] | null;
}

function useContentLines(content: FullScreenContent): ContentLines {
	const workDir = useWSStore((state) => state.workDir);
	const text =
		content.kind === "output" || content.kind === "code" ? content.text : null;
	const paths = content.kind === "files" ? content.paths : null;
	const isOutput = content.kind === "output";
	const parsed = useMemo(
		() => (isOutput && text !== null ? parseOutput(text) : null),
		[isOutput, text],
	);
	const code = useMemo(
		() => (!isOutput && text !== null ? outputLines(text) : null),
		[isOutput, text],
	);
	// A file row shows the path as `formatFilePath` puts it, which is the
	// text find has to match.
	const files = useMemo(
		() => paths?.map((path) => formatFilePath(path, workDir)) ?? null,
		[paths, workDir],
	);
	return { parsed, lines: parsed?.text ?? code ?? files };
}

/** What find searches in each kind of content. */
function findModelOf(
	content: FullScreenContent,
	lines: string[] | null,
): FindModel {
	if (lines) {
		return {
			kind: "lines",
			lines,
			firstLine:
				content.kind === "output" ? content.live?.droppedLines : undefined,
		};
	}
	// Drawn whole, so searched in what it renders to.
	return {
		kind: "dom",
		segments: content.kind === "change" ? diffSegments : markdownSegments,
	};
}

function ContentView({
	content,
	contentLines,
	from,
	wrap,
	scrollerRef,
	linesRef,
	onOpenFile,
}: {
	content: FullScreenContent;
	contentLines: ContentLines;
	from: "start" | "end";
	wrap: boolean;
	scrollerRef: RefObject<HTMLElement | null>;
	/** What brings a line into view, for the kinds drawn by the line. */
	linesRef: RefObject<VirtualLinesHandle | null>;
	onOpenFile: (open: () => void) => void;
}) {
	switch (content.kind) {
		// Drawn by the line, only where the reader is, so a huge log opens fast.
		case "output":
			return (
				<OutputLines
					content={content}
					// Parsed with the rest when the viewer drew this content; never
					// otherwise, but the types cannot tell.
					parsed={contentLines.parsed ?? parseOutput(content.text)}
					wrap={wrap}
					fromEnd={from === "end"}
					scrollerRef={scrollerRef}
					ref={linesRef}
				/>
			);
		case "code":
			return (
				<CodeLines
					content={content}
					lines={contentLines.lines ?? outputLines(content.text)}
					wrap={wrap}
					scrollerRef={scrollerRef}
					ref={linesRef}
				/>
			);
		case "files": {
			const open = content.onOpenFile;
			return (
				<FileLines
					content={content}
					onOpenFile={open && ((path) => onOpenFile(() => open(path)))}
					scrollerRef={scrollerRef}
					ref={linesRef}
				/>
			);
		}
		// Drawn whole: prose reflows, and the diff library draws a diff whole.
		case "markdown":
			// Prose as wide as a desktop is unreadable; logs and code take the
			// whole width.
			return content.markdown.length > HIGHLIGHT_LIMIT ? (
				<pre className="whitespace-pre-wrap break-words text-th-text-primary">
					{content.markdown}
				</pre>
			) : (
				<div className="mx-auto max-w-3xl">
					<MarkdownContent content={content.markdown} />
				</div>
			);
		case "change":
			return <ProposedChange change={content.change} />;
	}
}

/**
 * The F of Ctrl/Cmd+F: the letter where the layout has it, and the key where
 * it has none — on a Cyrillic or Greek layout the key says `а` or `φ`.
 */
function isFindKey(event: globalThis.KeyboardEvent): boolean {
	const key = event.key.toLowerCase();
	return key === "f" || (!/^[a-z]$/.test(key) && event.code === "KeyF");
}

/** Whether the content is drawn with a wrap switch, and whose choice it is. */
function wrapKind(content: FullScreenContent): "own" | "diff" | null {
	switch (content.kind) {
		case "output":
		case "code":
			return "own";
		case "change":
			return changeHasDiffs(content.change) ? "diff" : null;
		default:
			return null;
	}
}

interface Props {
	source: FullScreenSource;
	onClose: () => void;
	/** Closes, then runs `after` once the viewer's history entry is gone. */
	closeThen: (after: () => void) => void;
	afterCloseRef: RefObject<(() => void) | null>;
}

/**
 * One block of the transcript — a tool's result, a plan, a report, reasoning —
 * read on a screen of its own
 * (docs/tool-call-ui.md#full-screen): the block's own header as a toolbar, and
 * the content uncut in a scroller of its own.
 */
export function FullScreenViewer({
	source,
	onClose,
	closeThen,
	afterCloseRef,
}: Props) {
	const { content } = source;
	const scrollerRef = useRef<HTMLElement>(null);
	const linesRef = useRef<VirtualLinesHandle>(null);
	// Output wraps by default as the transcript always wraps it; code keeps its
	// shape. Neither is remembered: unwrapping is an occasional move for one
	// log. A diff's is the transcript's own remembered choice.
	const [ownWrap, setOwnWrap] = useState(content.kind === "output");
	const wraps = wrapKind(content);

	useBackToClose(onClose, afterCloseRef);

	const counted = useMemo(() => contentCount(content), [content]);
	const count = counted && formatCount(counted.total, counted.noun);

	const contentLines = useContentLines(content);
	const { lines } = contentLines;
	const firstLine =
		content.kind === "output" ? content.live?.droppedLines : undefined;
	const isChange = content.kind === "change";
	// biome-ignore lint/correctness/useExhaustiveDependencies: what the model is made of, not the content object republished with it
	const findModel = useMemo(
		() => findModelOf(content, lines),
		[lines, firstLine, isChange],
	);
	const [findOpen, setFindOpen] = useState(false);
	// Kept while the bar is closed, and restored, selected, on reopening.
	const [query, setQuery] = useState("");
	const findBarId = useId();
	const findInputRef = useRef<HTMLInputElement>(null);
	const findButtonRef = useRef<HTMLButtonElement>(null);

	const openFind = () => {
		setFindOpen(true);
		// Already open: the field is focused again, its query ready to replace.
		findInputRef.current?.focus();
		findInputRef.current?.select();
	};
	const closeFind = () => {
		setFindOpen(false);
		findButtonRef.current?.focus();
	};

	useEffect(() => {
		if (!findOpen) return;
		findInputRef.current?.focus();
		findInputRef.current?.select();
	}, [findOpen]);

	// The browser's own find cannot see lines not drawn, so the viewer's takes
	// the keys — on the document, so they work from the subject and the close
	// button too, which are outside the viewer's column.
	const openFindRef = useRef(openFind);
	openFindRef.current = openFind;
	useEffect(() => {
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (
				(event.ctrlKey || event.metaKey) &&
				!event.altKey &&
				!event.shiftKey &&
				isFindKey(event)
			) {
				event.preventDefault();
				openFindRef.current();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	// The first Escape puts find away and the next reaches the sheet, which
	// closes on it (docs/answering-ui.md#who-owns-escape). Claimed on the whole
	// column, as focus is as often in the content as in the field — and claimed
	// while composing too, where it only cancels the composition.
	const onColumnKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || !findOpen) return;
		event.stopPropagation();
		if (composing(event)) return;
		closeFind();
	};

	return (
		<Sheet
			title={source.title}
			subtitle={source.subject && <SubjectLine subject={source.subject} />}
			onClose={onClose}
			fullScreen
			initialFocusRef={scrollerRef}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: claims Escape for the find bar inside it */}
			<div className="flex h-full flex-col text-xs" onKeyDown={onColumnKeyDown}>
				{/* The block's header, so the reader sees the block they opened. Under
				    a subject line, cleared of its hit area, which reaches below it
				    under a thumb. */}
				<div
					className={`flex min-h-10 shrink-0 items-center gap-2 border-b border-th-border px-3 pointer-coarse:min-h-11 sm:px-4 ${
						source.subject ? "pointer-coarse:mt-2.5" : ""
					}`}
				>
					<div className="flex min-w-0 flex-1 items-center gap-2 text-th-text-muted">
						<span className="min-w-[3ch] shrink-[1000] truncate">
							{source.label}
						</span>
						{source.meta}
						{count && <span className="shrink-0 tabular-nums">{count}</span>}
					</div>
					<div className="flex shrink-0 items-center gap-1 pointer-coarse:gap-2">
						{wraps === "own" && (
							<WrapLinesToggle
								pressed={ownWrap}
								onToggle={() => setOwnWrap(!ownWrap)}
								size="lg"
							/>
						)}
						{wraps === "diff" && <DiffWrapToggle size="lg" />}
						{source.copyText && (
							<HeaderCopyButton
								text={source.copyText}
								label={`Copy ${source.noun}`}
								size="lg"
							/>
						)}
						{/* Last, nearest the thumb. */}
						<button
							ref={findButtonRef}
							type="button"
							aria-label="Find"
							aria-expanded={findOpen}
							aria-controls={findOpen ? findBarId : undefined}
							onClick={openFind}
							className={headerButtonClass("lg", findOpen)}
						>
							<Search size={16} aria-hidden="true" />
						</button>
					</div>
				</div>
				{findOpen && (
					<FindBar
						id={findBarId}
						noun={source.noun}
						model={findModel}
						query={query}
						onQueryChange={setQuery}
						onClose={closeFind}
						inputRef={findInputRef}
						scrollerRef={scrollerRef}
						linesRef={linesRef}
					/>
				)}
				{/* Focused on open, so the keys scroll it at once. */}
				<section
					ref={scrollerRef}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroller the keyboard has to reach
					tabIndex={0}
					aria-label={source.noun}
					className="relative min-h-0 flex-1 overflow-auto p-3 outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset sm:p-4"
				>
					<div>
						<ContentView
							content={content}
							contentLines={contentLines}
							from={source.from}
							wrap={ownWrap}
							scrollerRef={scrollerRef}
							linesRef={linesRef}
							onOpenFile={closeThen}
						/>
					</div>
				</section>
			</div>
		</Sheet>
	);
}
