import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	findInLines,
	findInText,
	findStatus,
	type LineMatch,
	matchAtOrAfter,
	stepMatch,
} from "../../lib/find";
import { headerButtonClass, inputClass } from "../ui";
import { LINE_INDEX_ATTR, type VirtualLinesHandle } from "./VirtualLines";

/**
 * What find searches in one kind of content.
 *
 * - `lines`: content drawn by the line, where most lines are not in the DOM —
 *   searched in its own text, one entry per drawn row.
 * - `dom`: content drawn whole — searched in the text it renders to, gathered
 *   by `segments` as runs of text nodes, each run one block of text.
 */
export type FindModel =
	| {
			kind: "lines";
			lines: string[];
			/** As `VirtualLines`' `firstLine`: the head dropped from live output. */
			firstLine?: number;
	  }
	| { kind: "dom"; segments: (root: HTMLElement) => Text[][] };

/** The highlights' names, styled in `index.css`. */
const MATCH = "find-match";
const CURRENT = "find-current";

/** Typing settles for this long before it is searched. */
const QUERY_DELAY_MS = 100;
/**
 * Content drawn whole is searched again this long after its DOM changes — a
 * diff's highlighter swaps its text in a node at a time.
 */
const DOM_SETTLE_MS = 250;

/** The Custom Highlight API, where the browser has it. */
function highlights(): HighlightRegistry | null {
	return typeof CSS !== "undefined" && "highlights" in CSS
		? CSS.highlights
		: null;
}

function paint(matches: Range[], current: Range | null) {
	const registry = highlights();
	if (!registry) return;
	// Added one by one: spread as arguments, a one-letter query over a large
	// document passes Safari's limit on a call's argument count.
	const all = new Highlight();
	for (const range of matches) if (range !== current) all.add(range);
	registry.set(MATCH, all);
	registry.set(CURRENT, current ? new Highlight(current) : new Highlight());
}

function clearPaint() {
	const registry = highlights();
	registry?.delete(MATCH);
	registry?.delete(CURRENT);
}

/** The text nodes under `root` in reading order, leaving out its buttons. */
function textNodes(root: Node): Text[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) =>
			node.parentElement?.closest("button")
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT,
	});
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push(node as Text);
	}
	return nodes;
}

/**
 * A range over `[start, end)` of the text the nodes make together, or null
 * if it runs past them.
 */
function rangeIn(nodes: Text[], start: number, end: number): Range | null {
	const range = document.createRange();
	let offset = 0;
	let started = false;
	for (const node of nodes) {
		const length = node.data.length;
		if (!started && start <= offset + length) {
			range.setStart(node, start - offset);
			started = true;
		}
		if (started && end <= offset + length) {
			range.setEnd(node, end - offset);
			return range;
		}
		offset += length;
	}
	return null;
}

/**
 * Whether a row's text is its line's, as drawn: shiki's tokens leave out a
 * line's closing carriage return, and HTML parsing — output is drawn through
 * `innerHTML` — reads every carriage return as a line feed. Either way the
 * offsets of a match before it are unchanged.
 */
function drawnAs(drawn: string, line: string): boolean {
	return (
		drawn === line ||
		drawn === line.replace(/\r$/, "") ||
		drawn === line.replaceAll("\r", "\n")
	);
}

function matchRanges(segments: Text[][], query: string): Range[] {
	const ranges: Range[] = [];
	for (const nodes of segments) {
		const text = nodes.map((node) => node.data).join("");
		for (const [start, end] of findInText(text, query)) {
			const range = rangeIn(nodes, start, end);
			if (range) ranges.push(range);
		}
	}
	return ranges;
}

/**
 * The part of the scroller the reader can see, in client coordinates: a
 * phone's keyboard covers the bottom of it without the layout knowing.
 */
function viewOf(scroller: HTMLElement): { top: number; bottom: number } {
	const rect = scroller.getBoundingClientRect();
	const visual = window.visualViewport;
	return visual
		? {
				top: Math.max(rect.top, visual.offsetTop),
				bottom: Math.min(rect.bottom, visual.offsetTop + visual.height),
			}
		: { top: rect.top, bottom: rect.bottom };
}

/** Where a match brought into view goes: a third of the way down. */
function thirdOf(view: { top: number; bottom: number }): number {
	return view.top + (view.bottom - view.top) / 3;
}

/**
 * Brings a match the reader cannot see into view — a third of the way down,
 * and sideways in every box between it and the scroller that scrolls that
 * way. One already in view is left where it is, unless `place` says it was
 * only put near by estimate and is to be placed now. `scrollBy` moves the
 * view up or down, for lines drawn by the line, which own their scrolling.
 * Says whether it moved.
 */
function bringIntoView(
	range: Range,
	scroller: HTMLElement,
	place: boolean,
	scrollBy = (delta: number) => {
		scroller.scrollTop += delta;
	},
): boolean {
	const rect = range.getBoundingClientRect();
	const view = viewOf(scroller);
	const before = scroller.scrollTop;
	if (place || rect.top < view.top || rect.bottom > view.bottom) {
		scrollBy(rect.top - thirdOf(view));
	}
	const moved = Math.abs(scroller.scrollTop - before) >= 1;
	// The margin keeps a match at the edge from sitting under it.
	const MARGIN = 24;
	for (
		let box = range.startContainer.parentElement;
		box && scroller.contains(box);
		box = box.parentElement
	) {
		// Only a box that scrolls: one that clips — a truncated path — would
		// be shifted with nothing to shift it back by.
		if (box.scrollWidth <= box.clientWidth) continue;
		const { overflowX } = getComputedStyle(box);
		if (overflowX !== "auto" && overflowX !== "scroll") continue;
		const bounds = box.getBoundingClientRect();
		const now = range.getBoundingClientRect();
		if (now.left < bounds.left) {
			box.scrollLeft -= bounds.left - now.left + MARGIN;
		} else if (now.right > bounds.right) {
			box.scrollLeft += now.right - bounds.right + MARGIN;
		}
	}
	return moved;
}

/**
 * How many times a match reached by estimate is placed again, as the rows
 * drawn around it are measured and move it, before it is left where it is.
 */
const PLACE_TRIES = 5;

/**
 * A match on a line, kept by the line's place in the whole — so it stays the
 * same match while live output grows and drops its head, and when the live
 * lines become the final ones, where it is counted from the end.
 */
interface HeldMatch {
	line: number;
	fromEnd: number;
	start: number;
	/** Counted in live lines, whose head may have been dropped. */
	live: boolean;
}

interface FindState {
	/** The query these are the matches of. */
	query: string;
	total: number;
	current: number | null;
}

/**
 * Searches a viewer's content, highlights every match, and steps the reader
 * through them. `query` is searched as given; an empty one clears it all.
 */
function useFind({
	model,
	query,
	scrollerRef,
	linesRef,
	onStatus,
}: {
	model: FindModel;
	query: string;
	scrollerRef: RefObject<HTMLElement | null>;
	linesRef: RefObject<VirtualLinesHandle | null>;
	/** A search's or a step's outcome, for a screen reader to be told. */
	onStatus: (state: FindState) => void;
}) {
	const [state, setState] = useState<FindState>({
		query: "",
		total: 0,
		current: null,
	});
	const lineMatchesRef = useRef<LineMatch[]>([]);
	const rangesRef = useRef<Range[]>([]);
	const currentRef = useRef<number | null>(null);
	const heldRef = useRef<HeldMatch | null>(null);
	/**
	 * The current match is to be brought into view once it is drawn. Its line
	 * scrolled to before it was drawn was put near only by an estimate of the
	 * rows' heights, and the rows measured as they are drawn move it again: it
	 * is `place`d, and again each time they move it, until they stop.
	 */
	const revealRef = useRef<
		{ mode: "ifNeeded" } | { mode: "place"; tries: number } | null
	>(null);
	const modelRef = useRef(model);
	modelRef.current = model;
	const onStatusRef = useRef(onStatus);
	onStatusRef.current = onStatus;

	const setCurrent = useCallback((current: number | null) => {
		currentRef.current = current;
		const match = current === null ? null : lineMatchesRef.current[current];
		const m = modelRef.current;
		heldRef.current =
			match && m.kind === "lines"
				? {
						line: (m.firstLine ?? 0) + match.index,
						fromEnd: m.lines.length - match.index,
						start: match.start,
						live: m.firstLine !== undefined,
					}
				: null;
	}, []);

	const total = () =>
		modelRef.current.kind === "lines"
			? lineMatchesRef.current.length
			: rangesRef.current.length;

	/** The ranges of the matches drawn now, and the current one's. */
	const drawnRanges = useCallback((): {
		all: Range[];
		current: Range | null;
	} => {
		const scroller = scrollerRef.current;
		const m = modelRef.current;
		if (m.kind === "dom") {
			const all = rangesRef.current;
			const at = currentRef.current;
			return { all, current: at === null ? null : (all[at] ?? null) };
		}
		const matches = lineMatchesRef.current;
		const all: Range[] = [];
		let current: Range | null = null;
		if (!scroller || matches.length === 0) return { all, current };
		const currentMatch =
			currentRef.current === null ? null : matches[currentRef.current];
		for (const row of scroller.querySelectorAll<HTMLElement>(
			`[${LINE_INDEX_ATTR}]`,
		)) {
			const index = Number(row.getAttribute(LINE_INDEX_ATTR));
			let i = matchAtOrAfter(matches, index);
			if (i === -1 || matches[i].index !== index) continue;
			const nodes = textNodes(row);
			// A row drawn from text other than the line's own (a stale render)
			// gets no highlights rather than misplaced ones.
			const drawn = nodes.map((node) => node.data).join("");
			if (!drawnAs(drawn, m.lines[index])) continue;
			for (; i < matches.length && matches[i].index === index; i++) {
				const range = rangeIn(nodes, matches[i].start, matches[i].end);
				if (!range) continue;
				all.push(range);
				if (matches[i] === currentMatch) current = range;
			}
		}
		return { all, current };
	}, [scrollerRef]);

	const repaint = useCallback(() => {
		const { all, current } = drawnRanges();
		paint(all, current);
		const scroller = scrollerRef.current;
		const reveal = revealRef.current;
		if (reveal && current && scroller) {
			revealRef.current = null;
			const place = reveal.mode === "place";
			const moved = bringIntoView(
				current,
				scroller,
				place,
				linesRef.current?.scrollBy,
			);
			if (place && moved && reveal.tries < PLACE_TRIES) {
				revealRef.current = { mode: "place", tries: reveal.tries + 1 };
			}
		}
	}, [drawnRanges, linesRef, scrollerRef]);

	/**
	 * Paints the matches and brings the current one into view, drawing its
	 * line first if need be.
	 */
	const reveal = useCallback(() => {
		const scroller = scrollerRef.current;
		const at = currentRef.current;
		revealRef.current = at === null ? null : { mode: "ifNeeded" };
		if (!scroller || at === null) {
			repaint();
			return;
		}
		const m = modelRef.current;
		if (m.kind === "lines") {
			const { current } = drawnRanges();
			if (!current) {
				// Not drawn: put its line where the match is to go, and let the
				// repaint once it is drawn place the match itself.
				revealRef.current = { mode: "place", tries: 0 };
				const view = viewOf(scroller);
				linesRef.current?.revealLine(
					lineMatchesRef.current[at].index,
					thirdOf(view) - scroller.getBoundingClientRect().top,
				);
				return;
			}
		}
		repaint();
	}, [drawnRanges, linesRef, repaint, scrollerRef]);

	/** The first match at or after the top of the view, wrapping to the first. */
	const firstInView = (): number | null => {
		const m = modelRef.current;
		const scroller = scrollerRef.current;
		if (total() === 0) return null;
		if (m.kind === "lines") {
			const top = linesRef.current?.topLine() ?? 0;
			const at = matchAtOrAfter(lineMatchesRef.current, top);
			return at === -1 ? 0 : at;
		}
		if (!scroller) return 0;
		const { top } = viewOf(scroller);
		const at = rangesRef.current.findIndex(
			(range) => range.getBoundingClientRect().bottom > top,
		);
		return at === -1 ? 0 : at;
	};

	/** The query last searched, which content that changes is searched for. */
	const searchedRef = useRef("");

	const publish = (q: string, announce: boolean) => {
		const next = { query: q, total: total(), current: currentRef.current };
		setState(next);
		if (announce) onStatusRef.current(next);
	};

	/** A new query: searched from the reader's place, which it is shown from. */
	const search = (q: string) => {
		searchedRef.current = q;
		const m = modelRef.current;
		const scroller = scrollerRef.current;
		if (m.kind === "lines") {
			lineMatchesRef.current = findInLines(m.lines, q);
		} else {
			rangesRef.current =
				scroller && q ? matchRanges(m.segments(scroller), q) : [];
		}
		setCurrent(q ? firstInView() : null);
		publish(q, Boolean(q));
		reveal();
	};

	/**
	 * The content changed under the same query: the current match stays the
	 * one it was — or the next after it, if it has gone — and the reader's view
	 * is left alone.
	 */
	const research = () => {
		const q = searchedRef.current;
		if (!q) return;
		const m = modelRef.current;
		if (m.kind === "lines") {
			const held = heldRef.current;
			const matches = findInLines(m.lines, q);
			lineMatchesRef.current = matches;
			let current: number | null = null;
			if (held) {
				const index =
					held.live && m.firstLine === undefined
						? m.lines.length - held.fromEnd
						: held.line - (m.firstLine ?? 0);
				const at =
					index < 0
						? matchAtOrAfter(matches, 0)
						: matchAtOrAfter(matches, index, held.start);
				current = at === -1 ? null : at;
			}
			setCurrent(current);
		} else {
			const scroller = scrollerRef.current;
			const before = currentRef.current;
			rangesRef.current =
				scroller && q ? matchRanges(m.segments(scroller), q) : [];
			const all = rangesRef.current.length;
			setCurrent(
				before === null || all === 0 ? null : Math.min(before, all - 1),
			);
		}
		publish(q, false);
		repaint();
	};

	const latest = useRef({ search, research });
	latest.current = { search, research };

	// A new query, once typing settles.
	useEffect(() => {
		const timer = setTimeout(() => {
			// Already searched by a step pressed before typing settled.
			if (searchedRef.current !== query) latest.current.search(query);
		}, QUERY_DELAY_MS);
		return () => clearTimeout(timer);
	}, [query]);

	// Lines that changed — live output growing, or becoming the result —
	// searched again at once, before the rows drawn from them are painted:
	// matches found in the old lines would land on whatever line now sits at
	// their row, and live output shifts every row each time its head drops.
	// Live output is two hundred lines; the result is searched once.
	const lines = model.kind === "lines" ? model.lines : null;
	useLayoutEffect(() => {
		if (lines) latest.current.research();
	}, [lines]);

	// Rows drawn as the reader scrolls, and whole content that re-renders (a
	// diff's highlighter swapping its text in), are highlighted as they come.
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		let frame = 0;
		let settle: ReturnType<typeof setTimeout> | undefined;
		const observer = new MutationObserver(() => {
			if (!searchedRef.current) return;
			if (modelRef.current.kind === "dom") {
				// Not put off again by each change: content that keeps changing
				// is still searched every so often.
				settle ??= setTimeout(() => {
					settle = undefined;
					latest.current.research();
				}, DOM_SETTLE_MS);
				return;
			}
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(repaint);
		});
		observer.observe(scroller, {
			childList: true,
			subtree: true,
			characterData: true,
			// A drawn row moving, as the rows around it are measured.
			attributeFilter: ["style"],
		});
		// The reader moving the view takes over from a match still being placed.
		const letGo = () => {
			revealRef.current = null;
		};
		const gestures = ["wheel", "touchstart", "pointerdown", "keydown"];
		for (const type of gestures) {
			scroller.addEventListener(type, letGo, { passive: true });
		}
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(settle);
			observer.disconnect();
			for (const type of gestures) scroller.removeEventListener(type, letGo);
		};
	}, [repaint, scrollerRef]);

	useEffect(() => clearPaint, []);

	const step = (delta: 1 | -1) => {
		// A step pressed before typing settles searches at once: the match it
		// lands on is the one the settled search would have shown.
		if (searchedRef.current !== query) {
			search(query);
			return;
		}
		const n = total();
		if (n === 0) return;
		const from = currentRef.current;
		let next: number | null;
		if (from === null) {
			// Nothing current yet — growth found the first matches: start from
			// the reader's place.
			next = firstInView();
			if (delta === -1) next = stepMatch(next, n, -1);
		} else {
			next = stepMatch(from, n, delta);
		}
		setCurrent(next);
		publish(searchedRef.current, true);
		reveal();
	};

	return { ...state, next: () => step(1), previous: () => step(-1) };
}

/** Whether a key press is part of an IME composition rather than its own. */
export function composing(event: KeyboardEvent): boolean {
	// 229 is what macOS and iOS Safari send for the Enter that commits a
	// composition, which arrives after `compositionend`.
	return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * Find's bar, under the viewer's toolbar (docs/tool-call-ui.md#full-screen).
 * The query is the viewer's, kept while the bar is closed.
 */
export function FindBar({
	id,
	noun,
	model,
	query,
	onQueryChange,
	onClose,
	inputRef,
	scrollerRef,
	linesRef,
}: {
	id: string;
	noun: string;
	model: FindModel;
	query: string;
	onQueryChange: (query: string) => void;
	onClose: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
	scrollerRef: RefObject<HTMLElement | null>;
	linesRef: RefObject<VirtualLinesHandle | null>;
}) {
	const [spoken, setSpoken] = useState("");
	const find = useFind({
		model,
		query,
		scrollerRef,
		linesRef,
		// A live region says nothing when its text is set to what it already
		// was — stepping through a single match — so every other status ends
		// in a no-break space, which a reader does not voice.
		onStatus: (state) =>
			setSpoken((before) => {
				const status = findStatus(state.current, state.total).spoken;
				return before === status ? `${status}\u00a0` : status;
			}),
	});
	// Nothing is shown for a query not yet searched, nor for an empty one.
	const searched = query !== "" && find.query === query;
	const status = searched ? findStatus(find.current, find.total) : null;
	const canStep = searched && find.total > 0;

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key !== "Enter" || composing(event)) return;
		event.preventDefault();
		if (query === "") return;
		if (event.shiftKey) find.previous();
		else find.next();
	};

	// A press on a step button leaves focus in the field, so a phone's keyboard
	// stays up between presses.
	const keepFocus = (event: { preventDefault: () => void }) =>
		event.preventDefault();

	return (
		<div
			id={id}
			className="flex min-h-11 shrink-0 items-center gap-2 border-b border-th-border px-3 sm:px-4"
		>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(event) => onQueryChange(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={`Find in ${noun}`}
				aria-label={`Find in ${noun}`}
				enterKeyHint="search"
				autoComplete="off"
				spellCheck={false}
				className={`min-w-0 flex-1 rounded bg-th-bg-primary px-2 py-1 text-xs text-th-text-primary placeholder:text-th-text-muted pointer-coarse:text-base ${inputClass}`}
			/>
			{status && (
				<span
					aria-hidden="true"
					className="shrink-0 text-xs text-th-text-muted tabular-nums"
				>
					{status.shown}
				</span>
			)}
			<span className="sr-only" aria-live="polite">
				{searched ? spoken : ""}
			</span>
			<div className="flex shrink-0 items-center gap-1 pointer-coarse:gap-2">
				<button
					type="button"
					aria-label="Previous match"
					disabled={!canStep}
					onMouseDown={keepFocus}
					onClick={find.previous}
					className={`${headerButtonClass("lg")} disabled:pointer-events-none disabled:opacity-40`}
				>
					<ChevronUp size={16} aria-hidden="true" />
				</button>
				<button
					type="button"
					aria-label="Next match"
					disabled={!canStep}
					onMouseDown={keepFocus}
					onClick={find.next}
					className={`${headerButtonClass("lg")} disabled:pointer-events-none disabled:opacity-40`}
				>
					<ChevronDown size={16} aria-hidden="true" />
				</button>
				<button
					type="button"
					aria-label="Close find"
					onClick={onClose}
					className={headerButtonClass("lg")}
				>
					<X size={16} aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

/** Markdown's blocks of text: a paragraph, a list item, a cell, a fence. */
const BLOCK =
	"p,li,td,th,pre,h1,h2,h3,h4,h5,h6,blockquote,dt,dd,figcaption,summary";

/**
 * Rendered Markdown's text, a run per block: a match never joins the end of
 * one paragraph to the start of the next.
 */
export function markdownSegments(root: HTMLElement): Text[][] {
	const segments: Text[][] = [];
	let block: Element | null = null;
	let run: Text[] = [];
	for (const node of textNodes(root)) {
		const at = node.parentElement?.closest(BLOCK) ?? null;
		if (at !== block && run.length > 0) {
			segments.push(run);
			run = [];
		}
		block = at;
		run.push(node);
	}
	if (run.length > 0) segments.push(run);
	return segments;
}

/** The code cells of `@git-diff-view`'s rows, which hold a line's text. */
const DIFF_CODE = ".diff-line-content-raw, .diff-line-syntax-raw";

/**
 * A diff's code, a run per line: never its line numbers, `@@` headers or file
 * headers — and on a phone the hidden old-number column still holds text.
 */
export function diffSegments(root: HTMLElement): Text[][] {
	const cells = [...root.querySelectorAll(DIFF_CODE)].filter(
		(cell) => !cell.parentElement?.closest(DIFF_CODE),
	);
	return cells.map((cell) => textNodes(cell));
}
