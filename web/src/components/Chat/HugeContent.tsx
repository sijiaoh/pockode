import { type RefObject, useLayoutEffect, useMemo, useState } from "react";
import type { FullScreenContent } from "../../lib/fullScreen";
import {
	canBeHuge,
	hugeOpenLabel,
	isHuge,
	sliceContent,
} from "../../lib/hugeContent";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { MarkdownContent, TRANSCRIPT_HEIGHT_VAR } from "../ui";
import { ProposedChange } from "./ProposedChange";
import { BashResultDisplay, FilePathRows } from "./ToolResultDisplay";

/** What huge content is judged against, taken once for the block. */
interface Metrics {
	transcriptRows: number;
	charsPerRow: number;
	/**
	 * False when taken in a box with no width — under a folded row, which
	 * keeps its body mounted but hidden — where `charsPerRow` is a guess until
	 * the box is first shown.
	 */
	widthKnown: boolean;
}

/** What a mono `text-xs` row holds when the width cannot be measured. */
const FALLBACK_CHARS_PER_ROW = 80;

/**
 * The height of the transcript `el` scrolls in. Asked where the transcript's
 * height is not published yet: a block mounted with the transcript measures
 * itself before the transcript publishes (`MessageList`, a parent's layout
 * effect). The tallest scroller rather than the nearest: a block can sit in a
 * small scroller of its own inside the transcript (the live turn's thought).
 */
function scrollerHeight(el: HTMLElement): number {
	let height = 0;
	for (let up = el.parentElement; up; up = up.parentElement) {
		const { overflowY } = getComputedStyle(up);
		if (overflowY === "auto" || overflowY === "scroll")
			height = Math.max(height, up.clientHeight);
	}
	return height;
}

function measure(el: HTMLElement): Metrics {
	const rem =
		Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
		16;
	const transcript =
		Number.parseFloat(
			getComputedStyle(el).getPropertyValue(TRANSCRIPT_HEIGHT_VAR),
		) ||
		scrollerHeight(el) ||
		window.innerHeight;
	const probe = document.createElement("span");
	probe.className = "invisible absolute font-mono text-xs whitespace-pre";
	probe.textContent = "0".repeat(10);
	el.appendChild(probe);
	const ch = probe.getBoundingClientRect().width / 10;
	probe.remove();
	const width = el.clientWidth;
	const widthKnown = ch > 0 && width > 0;
	return {
		transcriptRows: transcript / rem,
		charsPerRow: widthKnown ? Math.floor(width / ch) : FALLBACK_CHARS_PER_ROW,
		widthKnown,
	};
}

export interface HugeView {
	/** What the transcript draws in its place. */
	slice: FullScreenContent;
	/** The button that opens it in full: on screen, and to a screen reader. */
	label: string;
	name: string;
}

/**
 * Whether a block's content is huge (docs/tool-call-ui.md#huge-content), and
 * what is drawn of it if so.
 *
 * Judged against the transcript as it was when the block first had content,
 * from `rootRef`, the block's box: a keyboard opening or a rotation must not
 * flip a block between the two ways of reading it. Judged again only when the
 * content changes — and a block the reader has opened in place stays open.
 *
 * `pending` is the one commit before that first judgment, in which the block
 * draws nothing rather than drawing all of what may be huge: the judgment is
 * a layout effect, so nothing of that commit is painted.
 */
export function useHugeContent({
	content,
	from,
	noun,
	rootRef,
	openedInPlace,
	enabled,
}: {
	content: FullScreenContent | undefined;
	from: "start" | "end";
	noun: string;
	rootRef: RefObject<HTMLElement | null>;
	openedInPlace: boolean;
	/** False where there is no viewer to open it in. */
	enabled: boolean;
}): { pending: boolean; huge: HugeView | null } {
	const [metrics, setMetrics] = useState<Metrics | null>(null);
	const judged = enabled && content !== undefined && canBeHuge(content);

	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!judged || !el) return;
		if (!metrics) {
			setMetrics(measure(el));
			return;
		}
		if (metrics.widthKnown) return;
		// Hidden when first judged: its rows are counted again, once, when it
		// is first shown — before then the reader has seen neither way.
		const observer = new ResizeObserver(() => {
			const now = measure(el);
			if (!now.widthKnown) return;
			observer.disconnect();
			setMetrics({
				...metrics,
				charsPerRow: now.charsPerRow,
				widthKnown: true,
			});
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [judged, metrics, rootRef]);

	const hugeContent = useMemo(
		() =>
			judged && content && metrics && isHuge(content, metrics)
				? content
				: undefined,
		[judged, content, metrics],
	);
	const huge = useMemo<HugeView | null>(
		() =>
			hugeContent
				? {
						slice: sliceContent(hugeContent, from),
						...hugeOpenLabel(noun, hugeContent),
					}
				: null,
		[hugeContent, from, noun],
	);

	return {
		pending: judged && !metrics,
		huge: openedInPlace ? null : huge,
	};
}

/** The clamp's `huge` prop for a block whose content is `huge`. */
export function hugeClamp(
	huge: HugeView | null,
	key: string | undefined,
	open: (() => void) | null,
) {
	return huge && key !== undefined && open
		? { key, label: huge.label, name: huge.name, open }
		: undefined;
}

/**
 * What the transcript draws of huge content, as it draws the whole of
 * content of that kind.
 */
export function ContentSlice({ content }: { content: FullScreenContent }) {
	switch (content.kind) {
		case "output":
			return (
				<BashResultDisplay result={content.text} failed={content.failedTail} />
			);
		case "code":
			return (
				<CodeHighlighter
					language={content.language}
					plain={content.text.length > HIGHLIGHT_LIMIT}
					copyable={false}
				>
					{content.text}
				</CodeHighlighter>
			);
		case "markdown":
			return <MarkdownContent content={content.markdown} />;
		case "change":
			return <ProposedChange change={content.change} />;
		case "files":
			return (
				<FilePathRows paths={content.paths} onOpenFile={content.onOpenFile} />
			);
	}
}
