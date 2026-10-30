import {
	useCallback,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type LineMark,
	lineTop,
	measureCodeRows,
	NUMBERED_CODE_SELECTOR,
} from "../lib/codeRows";
import { fileLineCount } from "../lib/textLines";
import {
	ScrollRestorationContext,
	useFreshVisitLanding,
} from "./useScrollRestoration";

/**
 * Opens a numbered file view at `line`: the line a third of the way down the
 * page body, then a flash on it (docs/file.md#where-the-viewer-opens). Put
 * `containerRef` on an element around the numbered block and hand `mark` and
 * `clearMark` to it.
 *
 * Runs when the view mounts with its content, and again when the line or the
 * history entry changes — never on a refresh of the content. A return to an
 * entry keeps the offset it saved and gets no flash (`useFreshVisitLanding`);
 * a line past the end — the file shrank since it was searched — opens at the
 * top, unmarked.
 */
export function useLineLanding(line: number | undefined, content: string) {
	const land = useFreshVisitLanding();
	const entry = useContext(ScrollRestorationContext)?.entry ?? null;
	const containerRef = useRef<HTMLDivElement>(null);
	const [mark, setMark] = useState<LineMark | null>(null);
	// Read when landing, not a trigger: a refresh must not land again.
	const contentRef = useRef(content);
	contentRef.current = content;

	// The mark belongs to one entry and line, and is dropped as soon as the view
	// is on another — in render rather than in the effect, which StrictMode
	// reruns on mount: that second landing is refused, the entry having landed
	// already, and would leave nothing to flash. Dropped, not just hidden, or a
	// return within the flash would draw it again from the start.
	const key = line === undefined ? null : (entry ?? String(line));
	if (mark !== null && mark.key !== key) setMark(null);

	useLayoutEffect(() => {
		if (key === null || line === undefined || !land) return;
		const pre = containerRef.current?.querySelector<HTMLElement>(
			NUMBERED_CODE_SELECTOR,
		);
		if (!pre) return;
		const count = fileLineCount(contentRef.current);
		if (line < 1 || line > count) return;
		// Measured once: the scroll and the mark use the same numbers.
		const rows = measureCodeRows(pre, count);
		return land(
			(scroller) => {
				const lineY =
					pre.getBoundingClientRect().top -
					scroller.getBoundingClientRect().top +
					scroller.scrollTop +
					lineTop(rows, line);
				const max = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
				const top = Math.round(lineY - scroller.clientHeight / 3);
				return Math.min(Math.max(top, 0), max);
			},
			() => setMark({ line, rows, key }),
		);
	}, [key, line, land]);

	const clearMark = useCallback(() => setMark(null), []);
	return {
		containerRef,
		mark: mark?.key === key ? mark : null,
		clearMark,
	};
}
