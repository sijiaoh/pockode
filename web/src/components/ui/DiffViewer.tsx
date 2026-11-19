import { type DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import { useIsExpanded } from "@pockode/shared";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type DiffHunk, parseHunks } from "../../lib/diffHunks";
import type { LinePress, LineView } from "../../lib/diffRows";
import {
	CODE_FONT_SIZE_DESKTOP,
	CODE_FONT_SIZE_MOBILE,
	type DiffLanguage,
	getDiffHighlighterFor,
	getDiffLanguageFromPath,
	getIsDarkMode,
	getLoadedDiffHighlighter,
	subscribeToDarkMode,
} from "../../lib/shikiUtils";
import { exceedsHighlightLimit } from "../../utils/fileView";
import { splitPath } from "../../utils/path";
import { ContentErrorBoundary } from "./ContentErrorBoundary";
import { expandFromRowPress, labelCollapsedContext } from "./collapsedContext";
import { attachLineGutter, markSelectedLines } from "./lineGutter";

interface DiffViewerProps {
	fileName: string;
	hunks: string[];
	/**
	 * Both sides in full, which is what lets the unchanged lines between hunks
	 * be expanded. Without them only the hunks can be shown.
	 */
	oldContent?: string;
	newContent?: string;
	/** Wrap long lines rather than scroll them sideways. */
	wrap?: boolean;
	/** Old and new side by side rather than interleaved. */
	split?: boolean;
	/**
	 * A row of the caller's for each hunk, by its index across `hunks`.
	 *
	 * Drawn under the hunk's last line, not above its first: the library has
	 * no row above a hunk that exists in every state — the gap row above it
	 * goes once its gap is fully expanded, and a hidden line draws no extend
	 * row — while the last line belongs to the hunk and is always drawn. In
	 * split view, wrapped or not, the row is in one half, the side that line
	 * is on: the library gives each side's extend row a cell of its own.
	 */
	renderHunkBar?: (hunk: DiffHunk, index: number) => ReactNode;
	/**
	 * Makes the line numbers the control that selects lines, reporting each
	 * press for the caller to apply (lineGutter.ts). The caller owns the
	 * selection and hands it back as `selectedLines` to be drawn.
	 */
	onLinePress?: (press: LinePress) => void;
	selectedLines?: { view: LineView; keys: ReadonlySet<string> } | null;
}

type HunkBarRows = Record<string, { data: ReactNode }>;

/** The text of each side a patch shows, its context counted on both. */
function sidesOfHunks(hunks: string[]): [string, string] {
	const old: string[] = [];
	const next: string[] = [];
	for (const line of hunks.join("\n").split("\n")) {
		const mark = line[0];
		if (mark === "-" || mark === " ") old.push(line.slice(1));
		if (mark === "+" || mark === " ") next.push(line.slice(1));
	}
	return [old.join("\n"), next.join("\n")];
}

/**
 * Callers hand it patches through `lib/drawablePatch.ts`; the boundary is for
 * whatever input the library still turns out to choke on.
 */
export function DiffViewer(props: DiffViewerProps) {
	const raw = props.hunks.join("\n");
	return (
		// Another file is drawn afresh by the key, another patch by the reset
		// key — the patch itself, rather than a copy of it with the name.
		<ContentErrorBoundary
			key={props.fileName}
			name={splitPath(props.fileName).fileName}
			resetKey={raw}
			raw={raw}
		>
			<DiffViewerContent {...props} />
		</ContentErrorBoundary>
	);
}

function DiffViewerContent({
	fileName,
	hunks,
	oldContent,
	newContent,
	wrap = false,
	split = false,
	renderHunkBar,
	onLinePress,
	selectedLines = null,
}: DiffViewerProps) {
	const isDark = useSyncExternalStore(subscribeToDarkMode, getIsDarkMode);
	const isExpanded = useIsExpanded();
	const rootRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<{ getDiffFileInstance: () => DiffFile }>(null);

	const hunksKey = hunks.join("\0");
	// The library tokenizes each side whole, so either side past the ceiling
	// the rest of the app uses would freeze the page — a minified bundle is
	// a handful of lines but megabytes of text. Without the sides, it builds
	// them from the hunks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hunksKey` stands for `hunks`
	const plain = useMemo(() => {
		const sides =
			oldContent !== undefined || newContent !== undefined
				? [oldContent ?? "", newContent ?? ""]
				: sidesOfHunks(hunks);
		return sides.some(exceedsHighlightLimit);
	}, [oldContent, newContent, hunksKey]);

	// Drawn only once the file's grammar is in: the library colours a file once,
	// when it builds its model, so a diff drawn before would stay plain — and
	// one rebuilt after would flash from plain to coloured. A plain diff needs
	// neither highlighter nor grammar, so nothing is fetched for it.
	const pathLanguage = plain ? undefined : getDiffLanguageFromPath(fileName);
	const loadedNow = plain ? null : getLoadedDiffHighlighter(pathLanguage);
	const [fetched, setFetched] = useState<
		({ for: string | undefined } & DiffLanguage) | null
	>(null);
	const hasLoaded = loadedNow !== null;
	useEffect(() => {
		if (plain || hasLoaded) return;
		let current = true;
		getDiffHighlighterFor(pathLanguage).then((result) => {
			if (current) setFetched({ for: pathLanguage, ...result });
		});
		return () => {
			current = false;
		};
	}, [plain, pathLanguage, hasLoaded]);
	const ready = loadedNow ?? (fetched?.for === pathLanguage ? fetched : null);
	const highlighter = ready?.highlighter ?? null;
	const fileLang = ready?.language;
	const drawn = plain || highlighter !== null;

	// The library rebuilds its whole model whenever `data` is a new object —
	// re-parsing a large file and dropping every expanded gap — so it must
	// change only with the diff itself, not with wrap, theme or font size.
	// Keyed on the hunks' text, since callers build the array in render.
	// The language is passed rather than left to the library, which takes it
	// from the extension alone: `Dockerfile` would be a language of its own.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hunksKey` stands for `hunks`
	const data = useMemo(
		() => ({
			oldFile: { fileName, fileLang, content: oldContent },
			newFile: { fileName, fileLang, content: newContent },
			hunks,
		}),
		[fileName, fileLang, oldContent, newContent, hunksKey],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `hunksKey` stands for `hunks`
	const parsed = useMemo(() => parseHunks(hunks.join("\n")), [hunksKey]);
	// Rebuilt whenever the caller's rows change, which is what makes the
	// library draw them again: it re-renders an extend row when its entry here
	// is a new object, never when `renderExtendLine` alone changes.
	const extendData = useMemo(() => {
		if (!renderHunkBar) return undefined;
		const oldFile: HunkBarRows = {};
		const newFile: HunkBarRows = {};
		for (const [index, hunk] of parsed.entries()) {
			const row = split ? hunk.lastRow.split : hunk.lastRow.unified;
			(row.side === "old" ? oldFile : newFile)[row.lineNumber] = {
				data: renderHunkBar(hunk, index),
			};
		}
		return { oldFile, newFile };
	}, [parsed, renderHunkBar, split]);
	const renderExtendLine = useCallback(
		({ data }: { data: ReactNode }) => data,
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new `data` is a new model instance to follow
	useEffect(() => {
		const root = rootRef.current;
		const diffFile = viewRef.current?.getDiffFileInstance();
		if (!root || !diffFile) return;
		const label = () => labelCollapsedContext(root, diffFile, split);
		label();
		// Rows come and go as gaps expand, inside the library's own renders.
		// Observing only children keeps the attribute this writes from
		// re-triggering it.
		const observer = new MutationObserver(label);
		observer.observe(root, { childList: true, subtree: true });
		root.addEventListener("click", expandFromRowPress);
		return () => {
			observer.disconnect();
			root.removeEventListener("click", expandFromRowPress);
		};
	}, [drawn, data, split]);

	const linePress = useRef(onLinePress);
	linePress.current = onLinePress;
	const selectsLines = !!onLinePress;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the root is drawn once it needs nothing more
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !selectsLines) return;
		return attachLineGutter(root, (press) => linePress.current?.(press));
	}, [drawn, selectsLines]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: each of these redraws the rows the marks are on
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !selectsLines) return;
		const mark = () => markSelectedLines(root, selectedLines);
		mark();
		const observer = new MutationObserver(mark);
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [drawn, data, split, wrap, selectsLines, selectedLines]);

	if (!drawn) {
		return <div className="p-2 text-th-text-muted">Loading...</div>;
	}

	return (
		<div
			ref={rootRef}
			className="diff-view-wrapper diff-tailwindcss-wrapper"
			data-line-select={selectsLines || undefined}
		>
			<DiffView
				ref={viewRef}
				data={data}
				registerHighlighter={highlighter ?? undefined}
				diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
				diffViewWrap={wrap}
				diffViewTheme={isDark ? "dark" : "light"}
				diffViewHighlight={!plain}
				extendData={extendData}
				renderExtendLine={extendData ? renderExtendLine : undefined}
				diffViewFontSize={
					isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE
				}
			/>
		</div>
	);
}
