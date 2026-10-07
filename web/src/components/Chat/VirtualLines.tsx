import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type ReactNode,
	type Ref,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";

/**
 * What a view of lines can be asked to do from outside it — by find, which
 * has to bring a match into view on a line that is not drawn yet.
 */
export interface VirtualLinesHandle {
	/** The line at the top of the view. */
	topLine: () => number;
	/**
	 * Scrolls line `index` to `offset` pixels below the scroller's top edge —
	 * by estimate if it has not been drawn, so the caller refines once it is.
	 */
	revealLine: (index: number, offset: number) => void;
	/** Scrolls the view by `delta` pixels, a place the reader keeps. */
	scrollBy: (delta: number) => void;
}

/** The attribute each drawn row carries its line's index in. */
export const LINE_INDEX_ATTR = "data-line";

/** Lines drawn beyond the view each way, so a fast flick does not show blank. */
const OVERSCAN = 20;

/**
 * Where the reader is, in lines rather than pixels: the rows they have not
 * reached are only estimated, so a pixel offset names a different line as
 * soon as anything about the lines changes.
 */
interface Place {
	/** The top row's line, counted from the whole output's first. */
	line: number;
	/** The same row, counted from the last line. */
	fromEnd: number;
	/** How far into that row the view starts. */
	within: number;
}

interface Props {
	/**
	 * The viewer's scroller, which these lines scroll in — positioned, so the
	 * list's offset in it can be read from layout.
	 */
	scrollerRef: RefObject<HTMLElement | null>;
	count: number;
	/**
	 * The lines' identity, which changes whenever they do — for keeping the
	 * reader's place across the change.
	 */
	lines: unknown;
	/**
	 * Output still arriving whose first lines have been dropped: the first
	 * line's number in the whole. While the lines grow and lose their head,
	 * the reader's place is kept by this numbering; when they stop arriving
	 * and become the whole output, it is kept counted from the end, which is
	 * where the last of what arrived and the whole agree.
	 */
	firstLine?: number;
	/** A row's height before it is measured. */
	estimateRowHeight: number;
	/**
	 * Wrapped, a row is as tall as its line wraps to and as wide as the view.
	 * Unwrapped, every row is one line high and as wide as the longest, so the
	 * lines scroll sideways together as one block.
	 */
	wrap: boolean;
	/**
	 * The longest line's width in `ch`, which unwrapped rows share: only the
	 * drawn rows are in the DOM, and the block must not change width as they
	 * change.
	 */
	columns: number;
	/**
	 * Read from its end: opens at the last line, and stays there as lines
	 * arrive or rows are measured, until the reader scrolls away from it.
	 */
	fromEnd: boolean;
	renderRow: (index: number) => ReactNode;
	/** The list's own classes: its font, which `columns` is counted in. */
	className?: string;
	ref?: Ref<VirtualLinesHandle>;
}

/**
 * Lines drawn only where the reader is (docs/tool-call-ui.md#full-screen): a
 * ten-thousand-line log opens as fast as a short one. Each drawn row is
 * measured, so wrapped lines of any height scroll true.
 */
export function VirtualLines({
	scrollerRef,
	count,
	lines,
	firstLine,
	estimateRowHeight,
	wrap,
	columns,
	fromEnd,
	renderRow,
	className = "",
	ref,
}: Props) {
	const listRef = useRef<HTMLDivElement>(null);
	// Where the list starts in the scroller's content: below the scroller's
	// padding and whatever is drawn above the lines.
	const [scrollMargin, setScrollMargin] = useState(0);
	const atEndRef = useRef(fromEnd);
	const placeRef = useRef<Place | null>(null);
	/**
	 * The offset this view last wrote. The scroll event a write causes arrives
	 * after rows written past have been measured, and would read as the reader
	 * having left the end.
	 */
	const wroteRef = useRef<number | null>(null);
	/**
	 * The place is being held where it was put back, until the reader moves:
	 * rows measured after the change move it again, and every scroll until
	 * then is this view's or the virtualizer's own.
	 */
	const heldRef = useRef(false);
	/**
	 * The reader is moving the view — a finger or the scrollbar down, or the
	 * glide after one. A change then puts the place back once rather than
	 * holding it, which would pull the view back against the gesture.
	 */
	const movingRef = useRef(false);

	// A row's measured height belongs to its line, which while output arrives
	// moves to a lower index each time the head is dropped.
	const getItemKey = useCallback(
		(index: number) => (firstLine ?? 0) + index,
		[firstLine],
	);
	const virtualizer = useVirtualizer({
		count,
		getItemKey,
		getScrollElement: () => scrollerRef.current,
		estimateSize: () => estimateRowHeight,
		overscan: OVERSCAN,
		scrollMargin,
		// The virtualizer reads the scroller's offset only on a scroll event:
		// until the first, it has to be told the lines open at the end.
		initialOffset: () => (atEndRef.current ? count * estimateRowHeight : 0),
	});

	const write = (scroller: HTMLElement, top: number) => {
		scroller.scrollTop = top;
		wroteRef.current = scroller.scrollTop;
		// The virtualizer learns of an offset from the scroll event, a frame
		// late; until then it would draw the rows of the old one. Corrections
		// it has made for rows measured at the old one are void as well: the
		// offset written is where the reader is. Both fields are public but
		// their meaning is the library's (its core, which each release pins
		// exactly), which is why web/package.json pins the version too.
		virtualizer.scrollOffset = scroller.scrollTop;
		virtualizer.scrollAdjustments = 0;
	};

	const pinToEnd = () => {
		const scroller = scrollerRef.current;
		if (!scroller || !atEndRef.current) return;
		const end = scroller.scrollHeight - scroller.clientHeight;
		if (Math.abs(scroller.scrollTop - end) > 0.5) write(scroller, end);
	};

	const holdPlace = () => {
		const scroller = scrollerRef.current;
		const place = placeRef.current;
		if (!scroller || !place || !heldRef.current || atEndRef.current) return;
		const index = place.line - (firstLine ?? 0);
		// `getOffsetForIndex` reads the rows' layout as last computed; this
		// computes it anew, past rows just measured or lines just changed.
		virtualizer.getTotalSize();
		const [start] = virtualizer.getOffsetForIndex(index, "start") ?? [0];
		const top = start + place.within;
		if (Math.abs(scroller.scrollTop - top) > 0.5) write(scroller, top);
	};

	const readPlace = (scroller: HTMLElement) => {
		const item = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
		if (!item) return;
		placeRef.current = {
			line: (firstLine ?? 0) + item.index,
			fromEnd: count - item.index,
			within: scroller.scrollTop - item.start,
		};
	};

	// Every render follows a change that can move the end or the place: lines
	// arriving, rows measured, the wrap switched.
	useLayoutEffect(() => {
		pinToEnd();
		holdPlace();
	});

	useLayoutEffect(() => {
		const list = listRef.current;
		const scroller = scrollerRef.current;
		if (!list || !scroller) return;
		// Laid out rather than seen: the list's place in the scroller's content
		// is the same wherever it is scrolled to.
		const margin =
			list.offsetParent === scroller
				? list.offsetTop
				: list.getBoundingClientRect().top -
					scroller.getBoundingClientRect().top +
					scroller.scrollTop;
		if (Math.abs(margin - scrollMargin) > 0.5) setScrollMargin(margin);
	});

	// Unwrapped rows keep one height; wrapping or unwrapping changes them all —
	// forgotten before the place below is found among them.
	// biome-ignore lint/correctness/useExhaustiveDependencies: wrap is what invalidates the measurements
	useLayoutEffect(() => {
		virtualizer.measure();
	}, [wrap, virtualizer]);

	// The lines or their wrapping changed under a reader who is not at the end:
	// the line they were reading goes back to where it was, and is held there.
	const firstLineRef = useRef(firstLine);
	// biome-ignore lint/correctness/useExhaustiveDependencies: lines and wrap are the changes a place is kept across
	useLayoutEffect(() => {
		const wasLive = firstLineRef.current !== undefined;
		firstLineRef.current = firstLine;
		const place = placeRef.current;
		if (!place || atEndRef.current) return;
		const index =
			wasLive && firstLine === undefined
				? count - place.fromEnd
				: place.line - (firstLine ?? 0);
		const clamped = Math.min(Math.max(index, 0), count - 1);
		// Restated in the lines' numbering now, which `holdPlace` reads.
		placeRef.current = {
			line: (firstLine ?? 0) + clamped,
			fromEnd: count - clamped,
			within: clamped === index ? place.within : 0,
		};
		heldRef.current = true;
		holdPlace();
		if (movingRef.current) heldRef.current = false;
	}, [lines, wrap]);

	// The scroller's listeners outlive renders; they reach the latest one's
	// numbering and virtualizer through this.
	const latestRef = useRef({ pinToEnd, holdPlace, readPlace, fromEnd });
	latestRef.current = { pinToEnd, holdPlace, readPlace, fromEnd };
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		// A gesture lasts until its scrolling has stopped for this long: past
		// the finger lifting, through the glide it leaves.
		const SETTLE_MS = 250;
		let down = false;
		let settle: ReturnType<typeof setTimeout> | undefined;
		const settleLater = () => {
			clearTimeout(settle);
			settle = setTimeout(() => {
				if (!down) movingRef.current = false;
			}, SETTLE_MS);
		};
		const onScroll = () => {
			if (movingRef.current) settleLater();
			const wrote = wroteRef.current;
			wroteRef.current = null;
			if (wrote !== null && Math.abs(scroller.scrollTop - wrote) < 1) return;
			if (heldRef.current) return;
			if (latestRef.current.fromEnd) {
				atEndRef.current =
					scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
					2;
			}
			latestRef.current.readPlace(scroller);
		};
		// What the reader does to move, which lets go of a held place.
		const move = () => {
			heldRef.current = false;
			movingRef.current = true;
			settleLater();
		};
		const press = () => {
			heldRef.current = false;
			movingRef.current = true;
			down = true;
		};
		const lift = () => {
			down = false;
			settleLater();
		};
		const listeners = [
			["wheel", move],
			["keydown", move],
			["touchstart", press],
			["pointerdown", press],
		] as const;
		// On the window: a drag can end anywhere.
		const lifts = ["touchend", "touchcancel", "pointerup", "pointercancel"];
		// The scroller's own height changes too — the subject above it opening.
		const observer = new ResizeObserver(() => {
			latestRef.current.pinToEnd();
			latestRef.current.holdPlace();
		});
		observer.observe(scroller);
		scroller.addEventListener("scroll", onScroll, { passive: true });
		for (const [type, listener] of listeners) {
			scroller.addEventListener(type, listener, { passive: true });
		}
		for (const type of lifts) window.addEventListener(type, lift);
		return () => {
			clearTimeout(settle);
			observer.disconnect();
			scroller.removeEventListener("scroll", onScroll);
			for (const [type, listener] of listeners) {
				scroller.removeEventListener(type, listener);
			}
			for (const type of lifts) window.removeEventListener(type, lift);
		};
	}, [scrollerRef]);

	// Where the reader asked to go — by find: neither the end nor a held place
	// may pull the view back, and it is the place held across the next change
	// of the lines. Written, so the scroll event it causes is not read again —
	// nor by the virtualizer, which finds its offset already there and draws
	// nothing new until its scrolling settles: the rows of a far jump are
	// drawn by a render of its own.
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	const goTo = (top: number) => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		atEndRef.current = false;
		heldRef.current = false;
		write(scroller, Math.max(0, top));
		readPlace(scroller);
		redraw();
	};

	useImperativeHandle(ref, () => ({
		topLine: () => {
			const scroller = scrollerRef.current;
			if (!scroller) return 0;
			return (
				virtualizer.getVirtualItemForOffset(scroller.scrollTop)?.index ?? 0
			);
		},
		revealLine: (index, offset) => {
			// The row's own start, not `getOffsetForIndex`'s, which is held to
			// the furthest the view can scroll: a line on the last screen would
			// land `offset` below where it was meant to.
			// `getTotalSize` brings the measurements up to date first.
			virtualizer.getTotalSize();
			const start = virtualizer.measurementsCache[index]?.start ?? 0;
			goTo(start - offset);
		},
		scrollBy: (delta) => {
			const scroller = scrollerRef.current;
			if (scroller) goTo(scroller.scrollTop + delta);
		},
	}));

	return (
		<div
			ref={listRef}
			className={`relative ${className}`}
			style={{
				height: virtualizer.getTotalSize(),
				minWidth: wrap ? undefined : `${columns}ch`,
			}}
		>
			{virtualizer.getVirtualItems().map((item) => (
				<div
					key={item.key}
					ref={virtualizer.measureElement}
					data-index={item.index}
					{...{ [LINE_INDEX_ATTR]: item.index }}
					className={`absolute top-0 left-0 min-h-4 w-full ${
						wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
					}`}
					style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
				>
					{renderRow(item.index)}
				</div>
			))}
		</div>
	);
}
