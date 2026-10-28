import { type DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import type { getDiffViewHighlighter } from "@git-diff-view/shiki";
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
	getDiffHighlighter,
	getIsDarkMode,
	subscribeToDarkMode,
} from "../../lib/shikiUtils";
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

export function DiffViewer({
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
	const [highlighter, setHighlighter] = useState<Awaited<
		ReturnType<typeof getDiffViewHighlighter>
	> | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<{ getDiffFileInstance: () => DiffFile }>(null);

	useEffect(() => {
		getDiffHighlighter().then(setHighlighter);
	}, []);

	// The library rebuilds its whole model whenever `data` is a new object —
	// re-parsing a large file and dropping every expanded gap — so it must
	// change only with the diff itself, not with wrap, theme or font size.
	// Keyed on the hunks' text, since callers build the array in render.
	const hunksKey = hunks.join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `hunksKey` stands for `hunks`
	const data = useMemo(
		() => ({
			oldFile: { fileName, content: oldContent },
			newFile: { fileName, content: newContent },
			hunks,
		}),
		[fileName, oldContent, newContent, hunksKey],
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
	}, [highlighter, data, split]);

	const linePress = useRef(onLinePress);
	linePress.current = onLinePress;
	const selectsLines = !!onLinePress;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the root is drawn once the highlighter is in
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !selectsLines) return;
		return attachLineGutter(root, (press) => linePress.current?.(press));
	}, [highlighter, selectsLines]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: each of these redraws the rows the marks are on
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !selectsLines) return;
		const mark = () => markSelectedLines(root, selectedLines);
		mark();
		const observer = new MutationObserver(mark);
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [highlighter, data, split, wrap, selectsLines, selectedLines]);

	if (!highlighter) {
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
				registerHighlighter={highlighter}
				diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
				diffViewWrap={wrap}
				diffViewTheme={isDark ? "dark" : "light"}
				diffViewHighlight
				extendData={extendData}
				renderExtendLine={extendData ? renderExtendLine : undefined}
				diffViewFontSize={
					isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE
				}
			/>
		</div>
	);
}
