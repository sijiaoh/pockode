import { type DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { getDiffViewHighlighter } from "@git-diff-view/shiki";
import { useIsExpanded } from "@pockode/shared";
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	CODE_FONT_SIZE_DESKTOP,
	CODE_FONT_SIZE_MOBILE,
	getDiffHighlighter,
	getIsDarkMode,
	subscribeToDarkMode,
} from "../../lib/shikiUtils";
import { expandFromRowPress, labelCollapsedContext } from "./collapsedContext";

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
}

export function DiffViewer({
	fileName,
	hunks,
	oldContent,
	newContent,
	wrap = false,
	split = false,
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

	if (!highlighter) {
		return <div className="p-2 text-th-text-muted">Loading...</div>;
	}

	return (
		<div ref={rootRef} className="diff-view-wrapper diff-tailwindcss-wrapper">
			<DiffView
				ref={viewRef}
				data={data}
				registerHighlighter={highlighter}
				diffViewMode={split ? DiffModeEnum.Split : DiffModeEnum.Unified}
				diffViewWrap={wrap}
				diffViewTheme={isDark ? "dark" : "light"}
				diffViewHighlight
				diffViewFontSize={
					isExpanded ? CODE_FONT_SIZE_DESKTOP : CODE_FONT_SIZE_MOBILE
				}
			/>
		</div>
	);
}
