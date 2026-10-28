import { useIsExpanded } from "@pockode/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Binary, ChevronDown, ChevronUp, FileX } from "lucide-react";
import {
	type CSSProperties,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ThemedToken } from "shiki";
import { contentsQueryKey, useContents } from "../../hooks/useContents";
import { useFSWatch } from "../../hooks/useFSWatch";
import type { ConflictKind } from "../../lib/gitChanges";
import {
	type ConflictRegion,
	findConflictRegions,
	hasConflictMarkers,
	isMarkerLine,
} from "../../lib/gitOperation";
import {
	CODE_FONT_SIZE_DESKTOP,
	CODE_FONT_SIZE_MOBILE,
	getLanguageFromPath,
	highlightLines,
	lineHang,
	tokenStyle,
} from "../../lib/shikiUtils";
import { type ContentsResponse, isFileContent } from "../../types/contents";
import { getFileViewState, HIGHLIGHT_LIMIT } from "../../utils/fileView";
import FileBody, { PlainTextNotice } from "../Files/FileBody";
import { ContentView, FileStateCard, getActionIconButtonClass } from "../ui";

interface ConflictText {
	content: string;
	highlight: boolean;
}

export interface ConflictFile {
	contents: ReturnType<typeof useContents>;
	/** The working tree's text, or null when the file is not text (or not read yet). */
	text: ConflictText | null;
	/** The paired markers left in `text`, for the bands; empty when there is no text. */
	regions: ConflictRegion[];
	/**
	 * The text holds no marker at all, as last read and not being re-read:
	 * what offers `Mark resolved`. A card has no text to check — the agent's.
	 */
	resolvable: boolean;
	/**
	 * Reads the file again and says whether it is still resolvable: the cache
	 * may be a moment behind the disk, and staging records whatever is there.
	 */
	confirmResolvable: () => Promise<boolean>;
}

/**
 * Whatever came as text — an SVG or an HTML file included, which are
 * pictures and pages elsewhere and here the text holding the markers.
 */
function textOf(data: ContentsResponse | undefined): ConflictText | null {
	if (!data || !isFileContent(data) || data.encoding !== "text") return null;
	return { content: data.content, highlight: data.size <= HIGHLIGHT_LIMIT };
}

/**
 * The working-tree file of a conflicted path, read with the file layer's own
 * reader and watched as it watches it, so an edit by the agent shows up in
 * place. Not read for a path both sides deleted: there is nothing on disk.
 */
export function useConflictFile(
	path: string,
	conflict: ConflictKind | undefined,
): ConflictFile {
	const queryClient = useQueryClient();
	const enabled = conflict !== undefined && conflict !== "deleted-both";
	const contents = useContents(path, enabled);
	useFSWatch({
		path,
		enabled,
		onChanged: useCallback(() => {
			queryClient.invalidateQueries({ queryKey: contentsQueryKey(path) });
		}, [queryClient, path]),
	});

	const { data, isFetching, error, refetch } = contents;
	const text = useMemo(() => (enabled ? textOf(data) : null), [enabled, data]);
	const regions = useMemo(
		() => (text ? findConflictRegions(text.content) : []),
		[text],
	);
	const resolvable =
		conflict === "content" &&
		text !== null &&
		!isFetching &&
		!error &&
		!hasConflictMarkers(text.content);
	const confirmResolvable = useCallback(async () => {
		const result = await refetch();
		if (result.isError) return false;
		const now = textOf(result.data);
		return now !== null && !hasConflictMarkers(now.content);
	}, [refetch]);
	return { contents, text, regions, resolvable, confirmResolvable };
}

interface Props {
	path: string;
	conflict: ConflictKind;
	file: ConflictFile;
	wrap: boolean;
	onOpenFile: () => void;
}

/**
 * The review layer's body for a conflicted path (docs/git-conflict-ui.md,
 * Viewing a conflicted file): the working-tree text with its markers banded
 * and a jump between conflicts, or a card when the conflict is not in a text.
 * Neither side is named: in a rebase "ours" is the other branch.
 */
export default function ConflictView({
	path,
	conflict,
	file,
	wrap,
	onOpenFile,
}: Props) {
	if (conflict === "deleted-both") {
		return <FileStateCard icon={FileX} title="Both sides deleted this file." />;
	}

	const { data, isLoading, error } = file.contents;
	if (conflict === "deleted-one-side") {
		const onDisk = !!data && isFileContent(data);
		return (
			<FileStateCard
				icon={FileX}
				title="One side deleted this file and the other changed it."
				action={
					onDisk ? { label: "Open file", onClick: onOpenFile } : undefined
				}
			/>
		);
	}

	return (
		<ContentView
			isLoading={isLoading}
			error={error instanceof Error ? error : null}
			// The text scrolls itself, under the conflict row that stays put.
			fill={file.text !== null}
		>
			<ConflictContent path={path} file={file} wrap={wrap} />
		</ContentView>
	);
}

function ConflictContent({
	path,
	file,
	wrap,
}: {
	path: string;
	file: ConflictFile;
	wrap: boolean;
}) {
	const data = file.contents.data;
	if (!data || !isFileContent(data)) return null;
	if (file.text) {
		return (
			<ConflictLines
				path={path}
				text={file.text}
				regions={file.regions}
				wrap={wrap}
			/>
		);
	}
	const viewed = getFileViewState(data, { kind: "file", path });
	// A page too large to read is its source's card, not a frame.
	const state = viewed.kind === "page" ? viewed.source : viewed;
	if (state.kind === "binary" || data.encoding === "http") {
		return (
			<FileStateCard
				icon={Binary}
				title="Binary file — the conflict cannot be shown."
			/>
		);
	}
	// Too large to read, say: the file layer's own card says why.
	return <FileBody state={state} path={path} readOnly />;
}

/** A pixel of slack for a scroll position the browser rounded. */
const EPSILON = 1;

interface Position {
	label: string;
	prev: number | null;
	next: number | null;
}

function countLabel(total: number): string {
	return total === 1 ? "1 conflict" : `${total} conflicts`;
}

/**
 * Where the reader is among the regions, `starts` being the scroll position
 * that puts each region's first line at the top. The count names the region
 * whose start is nearest above the top of the view; at the bottom, where a
 * later region can no longer reach the top, the last one whose start is in
 * view.
 */
function positionOf(scroller: HTMLElement, starts: number[]): Position {
	const total = starts.length;
	const top = scroller.scrollTop;
	const height = scroller.clientHeight;
	const room = scroller.scrollHeight - height;
	if (room <= EPSILON) {
		return { label: countLabel(total), prev: null, next: null };
	}
	const atBottom = top >= room - EPSILON;

	let current = -1;
	let prev: number | null = null;
	let next: number | null = null;
	starts.forEach((start, i) => {
		const reached = atBottom ? start < top + height : start <= top + EPSILON;
		if (reached) current = i;
		if (start < top - EPSILON) prev = i;
		if (next === null && !atBottom && start > top + EPSILON) next = i;
	});
	return {
		label:
			current === -1
				? countLabel(total)
				: `Conflict ${current + 1} of ${total}`,
		prev,
		next,
	};
}

const samePosition = (a: Position, b: Position) =>
	a.label === b.label && a.prev === b.prev && a.next === b.next;

function ConflictLines({
	path,
	text,
	regions,
	wrap,
}: {
	path: string;
	text: ConflictText;
	regions: ConflictRegion[];
	wrap: boolean;
}) {
	const isExpanded = useIsExpanded();
	const scrollerRef = useRef<HTMLDivElement>(null);
	const { content, highlight } = text;
	const lines = useMemo(
		() => content.replace(/\n$/, "").split("\n"),
		[content],
	);
	const language = getLanguageFromPath(path);
	const [highlighted, setHighlighted] = useState<{
		content: string;
		tokens: ThemedToken[][];
	} | null>(null);

	// Coloured as the full screen viewer colours code it draws by the line:
	// over the whole text, plain until the colours arrive.
	useEffect(() => {
		if (!highlight || !language) return;
		let current = true;
		highlightLines(content, language).then(
			(tokens) => {
				if (current && tokens) setHighlighted({ content, tokens });
			},
			// Uncoloured code is still the code.
			() => {},
		);
		return () => {
			current = false;
		};
	}, [content, highlight, language]);
	const tokens = highlighted?.content === content ? highlighted.tokens : null;

	// 0: plain, 1: inside a region, 2: a marker line.
	const kinds = useMemo(() => {
		const out = new Uint8Array(lines.length);
		for (const region of regions) {
			for (let i = region.start; i <= region.end; i++) {
				out[i] = isMarkerLine(region, i) ? 2 : 1;
			}
		}
		return out;
	}, [lines, regions]);

	const [position, setPosition] = useState<Position>({
		label: countLabel(regions.length),
		prev: null,
		next: null,
	});
	// Measured when the rows move, not on every scroll frame: reading offsets
	// forces a layout.
	const starts = useRef<number[]>([]);
	const update = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		const next = positionOf(scroller, starts.current);
		setPosition((prev) => (samePosition(prev, next) ? prev : next));
	}, []);
	const measure = useCallback(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		const row = (line: number) =>
			scroller.querySelector<HTMLElement>(`[data-line="${line}"]`)?.offsetTop ??
			0;
		// From the first line, so the padding above it does not leave a
		// conflict on line 1 unreached at the top.
		const base = row(0);
		starts.current = regions.map((r) => row(r.start) - base);
		update();
	}, [regions, update]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: what moves the rows, without changing `measure`
	useLayoutEffect(measure, [measure, lines, wrap, tokens]);
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [measure]);

	const jumpTo = (index: number | null) => {
		const scroller = scrollerRef.current;
		if (index === null || !scroller) return;
		scroller.scrollTop = starts.current[index];
		update();
	};

	const fontSize = isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{regions.length > 0 ? (
				<div className="flex min-h-[44px] shrink-0 items-center gap-1 border-b border-th-border px-2 pointer-coarse:gap-2">
					{/* Announced, since it is the one thing a jump changes besides
					    the scroll. */}
					<span
						aria-live="polite"
						aria-atomic="true"
						className="min-w-0 flex-1 truncate px-1 text-xs tabular-nums text-th-text-muted"
					>
						{position.label}
					</span>
					<button
						type="button"
						disabled={position.prev === null}
						onClick={() => jumpTo(position.prev)}
						className={getActionIconButtonClass(position.prev !== null)}
						aria-label="Previous conflict"
					>
						<ChevronUp className="h-4 w-4" aria-hidden="true" />
					</button>
					<button
						type="button"
						disabled={position.next === null}
						onClick={() => jumpTo(position.next)}
						className={getActionIconButtonClass(position.next !== null)}
						aria-label="Next conflict"
					>
						<ChevronDown className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			) : (
				<div className="shrink-0 border-b border-th-border bg-th-bg-secondary px-4 py-2 text-xs text-th-text-muted">
					{hasConflictMarkers(content)
						? "Conflict markers are left that do not pair up. Fix them in the file, or ask the agent."
						: "No conflict markers left. The file stays conflicted until it is marked resolved."}
				</div>
			)}
			{!highlight && <PlainTextNotice />}
			{/* Positioned, so a row's offsetTop is its place in what scrolls. */}
			<div
				ref={scrollerRef}
				onScroll={update}
				className="relative min-h-0 flex-1 overflow-auto bg-th-code-bg"
			>
				<Rows
					lines={lines}
					tokens={tokens}
					kinds={kinds}
					wrap={wrap}
					fontSize={fontSize}
				/>
			</div>
		</div>
	);
}

/**
 * Every line of the file, kept apart so that a scroll — which moves the
 * count — does not redraw them: there may be thousands.
 */
const Rows = memo(function Rows({
	lines,
	tokens,
	kinds,
	wrap,
	fontSize,
}: {
	lines: string[];
	tokens: ThemedToken[][] | null;
	kinds: Uint8Array;
	wrap: boolean;
	fontSize: number;
}) {
	const gutter = `${String(lines.length).length + 1}ch`;
	return (
		<div
			className={`py-2 font-mono leading-[1.6] [color:var(--shiki-foreground)] ${
				wrap ? "" : "w-max min-w-full"
			}`}
			style={{ fontSize }}
		>
			{lines.map((line, i) => {
				const kind = kinds[i];
				// A marker line is the band's, not the language's: shiki reads it
				// as whatever syntax it happens to resemble.
				const row = kind === 2 ? undefined : tokens?.[i];
				// A wrapped line's continuation hangs past its indent, as the
				// transcript's wrapped code does.
				const hang = wrap ? lineHang(line) : undefined;
				return (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: a row is a line number
						key={i}
						data-line={i}
						className={`flex border-l-[3px] pr-4 ${
							kind ? "border-th-warning" : "border-transparent"
						} ${kind === 2 ? "bg-th-warning/15" : ""}`}
					>
						<span
							aria-hidden="true"
							className="shrink-0 select-none pr-3 text-right text-th-text-muted"
							style={{ width: gutter, boxSizing: "content-box" }}
						>
							{i + 1}
						</span>
						<span
							className={
								wrap
									? "min-w-0 flex-1 whitespace-pre-wrap pl-[var(--hang,2ch)] -indent-[var(--hang,2ch)] [overflow-wrap:anywhere]"
									: "whitespace-pre"
							}
							style={hang ? ({ "--hang": hang } as CSSProperties) : undefined}
						>
							{row
								? row.map((token, t) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: a line's tokens are fixed
										<span key={t} style={tokenStyle(token)}>
											{token.content}
										</span>
									))
								: line || " "}
						</span>
					</div>
				);
			})}
		</div>
	);
});
