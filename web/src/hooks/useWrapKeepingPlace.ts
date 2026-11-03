import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { lineAt, lineBox, NUMBERED_CODE_SELECTOR } from "../lib/codeRows";
import { fileLineCount } from "../lib/textLines";
import { scrollParent } from "../utils/scrollParent";

interface Options {
	/**
	 * The numbered block is one wrapping can change, so that both layouts of
	 * it are the same lines — where it is not, there is no place to keep.
	 */
	wrappable: boolean;
	content: string;
	/** Around the numbered block, as `useLineLanding`'s. */
	containerRef: RefObject<HTMLElement | null>;
	/** The layout is about to change: drop what was measured in the old one. */
	onRelayout: () => void;
}

/**
 * The line at the top of the scroller, and how far the scroller's top is into
 * it: a share of its height where the line is cut by the top edge — wrapping
 * changes the height, and a pixel offset taller than the new line would leave
 * it above the page — or, where the whole line is below the edge (the top of
 * the file), the pixels down to it.
 */
interface Anchor {
	line: number;
	into: { share: number } | { below: number };
}

function anchorAt(pre: HTMLElement, top: number, count: number): Anchor {
	const line = lineAt(pre, top, count);
	const box = lineBox(pre, line, count);
	return {
		line,
		into:
			top > box.top
				? { share: (top - box.top) / box.height }
				: { below: box.top - top },
	};
}

interface Applied {
	wrap: boolean;
	wrappable: boolean;
	content: string;
}

function numberedView(container: HTMLElement | null) {
	const pre = container?.querySelector<HTMLElement>(NUMBERED_CODE_SELECTOR);
	const scroller = pre && scrollParent(pre);
	return pre && scroller ? { pre, scroller } : null;
}

/** How far the scroller's top edge is below the `pre`'s. */
function viewTop(pre: HTMLElement, scroller: HTMLElement): number {
	return scroller.getBoundingClientRect().top - pre.getBoundingClientRect().top;
}

/**
 * The wrap a numbered view should draw with, one step behind `wrap`, so that
 * toggling it — or the width tier deciding it — keeps the line at the top of
 * the page where it was (`Anchor`; docs/file.md#wrapped). The anchor has to
 * be read in the old layout, which a layout effect on the new `wrap` would
 * already find gone: so the old layout stays for one commit, the anchor is
 * read from it, and the new one is applied and scrolled to the anchor — both
 * before paint, so no frame in between shows.
 *
 * Only a change of `wrap` alone waits a step. With other content, or a block
 * that was or is not wrappable, there is nothing of the old layout to keep,
 * and `wrap` applies at once.
 */
export function useWrapKeepingPlace(
	wrap: boolean,
	{ wrappable, content, containerRef, onRelayout }: Options,
): boolean {
	const [applied, setApplied] = useState<Applied>({
		wrap,
		wrappable,
		content,
	});
	const keepsPlace =
		wrappable && applied.wrappable && content === applied.content;
	if (
		!keepsPlace &&
		(applied.wrap !== wrap ||
			applied.wrappable !== wrappable ||
			applied.content !== content)
	) {
		setApplied({ wrap, wrappable, content });
	}
	const anchor = useRef<Anchor | null>(null);
	const onRelayoutRef = useRef(onRelayout);
	onRelayoutRef.current = onRelayout;

	useLayoutEffect(() => {
		if (!keepsPlace || applied.wrap === wrap) return;
		const view = numberedView(containerRef.current);
		const count = fileLineCount(content);
		if (view && count > 0) {
			anchor.current = anchorAt(
				view.pre,
				viewTop(view.pre, view.scroller),
				count,
			);
		}
		onRelayoutRef.current();
		setApplied({ ...applied, wrap });
	}, [keepsPlace, applied, wrap, content, containerRef]);

	useLayoutEffect(() => {
		const kept = anchor.current;
		anchor.current = null;
		if (!kept) return;
		const view = numberedView(containerRef.current);
		if (!view) return;
		const { pre, scroller } = view;
		const box = lineBox(pre, kept.line, fileLineCount(applied.content));
		const top =
			"share" in kept.into
				? box.top + kept.into.share * box.height
				: box.top - kept.into.below;
		scroller.scrollTop += top - viewTop(pre, scroller);
		// Nothing is left to the side once lines wrap.
		if (applied.wrap) scroller.scrollLeft = 0;
	}, [applied, containerRef]);

	return keepsPlace ? applied.wrap : wrap;
}
