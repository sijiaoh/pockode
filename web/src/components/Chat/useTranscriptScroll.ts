import {
	type RefObject,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Message } from "../../types/message";
import { isTypedByUser } from "../../utils/messageSource";
import {
	anchorOn,
	anchorScrollTop,
	holdingAnchor,
	pickAnchor,
	type ScrollAnchor,
	type Seam,
	seamScrollTop,
	takeSeam,
} from "./scrollAnchor";
import type { TranscriptView } from "./transcriptViewContext";
import { coveredAbove } from "./useFoldLanding";

/**
 * How close to the end counts as the end. Never asked on its own for the
 * reader's scrolling: reaching it is only a return to the tail when the view
 * got there moving *down*, or a card collapsing below the reader would clamp
 * the view to the end and be taken for one.
 */
const AT_BOTTOM_THRESHOLD = 50;
/**
 * How far up from the view's bottom edge the scroll button reaches, hit area
 * included: its `bottom-3` offset, plus the coarse pointer's 44px floor, plus a
 * little air. Whatever must stay pressable is kept out of this band.
 */
const BUTTON_BAND = 60;

/**
 * Every element currently marked keep-clear, in any transcript. Registered by
 * the mark itself rather than looked up: the band is asked after every commit
 * while the view follows a streaming tail, and a selector over the transcript
 * cost that look 10–30 ms a record in a long session — growing with the
 * history, when what it finds is at most a card or two.
 */
const keepClearNodes = new Set<HTMLElement>();

function registerKeepClear(node: HTMLElement | null) {
	if (!node) return;
	keepClearNodes.add(node);
	return () => {
		keepClearNodes.delete(node);
	};
}

/**
 * Marks controls the scroll button must never be drawn over — a pending
 * permission card's answers. Spread onto them: `<div {...keepClearProps}>`,
 * on an element that takes no ref of its own.
 */
export const keepClearProps = { ref: registerKeepClear };

/**
 * Whether anything marked keep-clear is in the band the button sits in. Asked
 * of the layout, not of the rows: what is below a card — the turn-end slot, a
 * message sent after it — moves the card in and out of the band by its height,
 * which is how a fixed "near the end" distance once let the button cover Allow.
 */
function keepClearInBand(el: HTMLElement): boolean {
	if (keepClearNodes.size === 0) return false;
	const bottom = el.getBoundingClientRect().bottom;
	for (const node of keepClearNodes) {
		if (!el.contains(node)) continue;
		const rect = node.getBoundingClientRect();
		if (rect.bottom > bottom - BUTTON_BAND && rect.top < bottom) return true;
	}
	return false;
}

/**
 * Movement below this is not worth a write. Both heights a scroll box is made of
 * are integers while `scrollTop` is not, so "pinned to the end" is only ever
 * reached to within a pixel, and a write that moves nothing still cancels iOS
 * momentum scrolling.
 */
const DRIFT_TOLERANCE = 1;

/**
 * How long without a scroll event, with nothing pressed, counts as the view
 * being at rest — the only time the track and `scrollTop` are put back in line
 * (`settle`). Long enough to span the gap between two scroll events of an iOS
 * flick's momentum, which arrive a frame or two apart; short enough that a
 * reader who stopped does not wait on it.
 */
const REST_DELAY_MS = 120;

/**
 * The least the history reserve is restored to, so the failure band placed on
 * its bottom edge — two lines and their padding — always fits once the view is
 * at rest (`HistoryReserve`).
 */
const MIN_RESERVE = 96;

/**
 * Which of the two things the reader is doing. There is no third state, and
 * nothing samples where the view happens to sit to decide between them: a
 * position sample cannot tell a frame of our own following from the reader
 * leaving, which is how following used to be lost for good.
 */
type ReadingState = "tail" | "anchored";

/**
 * What the end of the transcript shows, compared value by value by identity:
 * when it changes while the reader is away, something has arrived below them.
 * Not the content's height, which also grows when an older page lands above,
 * or a row in the middle opens.
 */
export type TailSignature = readonly unknown[];

/**
 * The chat's: the reducer updates immutably, so every streamed chunk is a new
 * `parts` array and a turn failing sets `error` — but not the message object
 * itself: an `anchorSeq` backfill replaces that too, and it changes nothing
 * anyone can see.
 */
function tailSignature(messages: Message[]): TailSignature {
	const last = messages[messages.length - 1];
	if (!last) return [];
	return last.role === "assistant"
		? [last.id, last.parts, last.error]
		: [last.id, last.content];
}

function sameSignature(a: TailSignature, b: TailSignature): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The rows appended after the newest row of the previous commit that is still
 * there, or `"replaced"` when none of them is. Measured from the newest
 * *surviving* row because rows also go: an empty reply bubble is dropped as the
 * next message closes its turn, and a refused send's echo is taken back out.
 */
function rowsAdded(prev: Message[], next: Message[]): Message[] | "replaced" {
	if (prev.length === 0) return next;
	if (next[next.length - 1]?.id === prev[prev.length - 1].id) return [];
	const indexById = new Map(next.map((m, i) => [m.id, i]));
	for (let i = prev.length - 1; i >= 0; i--) {
		const at = indexById.get(prev[i].id);
		if (at !== undefined) return next.slice(at + 1);
	}
	return "replaced";
}

function maxScrollTop(el: HTMLElement): number {
	return Math.max(0, el.scrollHeight - el.clientHeight);
}

/**
 * The offset that puts `target` at the top of the view, under whatever its
 * `scroll-margin-top` says is pinned there: inside an open row that is the
 * bar pinned over it (`index.css`), which a target landed at the very top
 * would be under.
 */
function scrollTopFor(el: HTMLElement, target: HTMLElement): number {
	return (
		el.scrollTop +
		target.getBoundingClientRect().top -
		el.getBoundingClientRect().top -
		(Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0)
	);
}

/**
 * The chat's messages as `useTranscriptScroll` reads them: the end they show,
 * and the commits that put the reader back on the tail.
 */
export function useMessagesTail(
	messages: Message[],
	loadedHistoryPages: number,
): Pick<Options, "tail" | "returnsToTail"> {
	// The rows of the previous commit, read by id: what makes a message "just
	// sent" is that it was not there a commit ago, and a count cannot say that —
	// an older page landing above grows the list without adding anything at the
	// end, and it routinely lands under a transcript whose newest row is one the
	// reader typed.
	const prevRef = useRef({ messages, pages: loadedHistoryPages });
	const returnsToTail = () => {
		const prev = prevRef.current;
		prevRef.current = { messages, pages: loadedHistoryPages };
		const added = rowsAdded(prev.messages, messages);
		if (
			loadedHistoryPages < prev.pages ||
			(added === "replaced" && loadedHistoryPages === prev.pages)
		) {
			// The transcript was replaced, which only a reconnect answered with
			// a snapshot does: it lands back on the newest page. A resumed one
			// keeps its rows, and what it missed arrives as an update does.
			// Paging starting over says so when pages had been loaded; with none,
			// the count cannot drop, but replaying history mints every row a new
			// id. The rows an anchor names are gone or at offsets it was never
			// measured against, and the newest page is what was asked for.
			return true;
		}
		// Sending is the reader saying where they are reading next; they have just
		// written at the end of the conversation. Any new row, not only the last: a
		// message sent to an idle agent lands with its reply's placeholder below
		// it. Rows nobody typed — Pockode's own, another agent's answer to a posted
		// question — are nobody's gesture and say nothing about that.
		return added !== "replaced" && added.some(isTypedByUser);
	};
	return { tail: tailSignature(messages), returnsToTail };
}

interface Options {
	scrollRef: RefObject<HTMLElement | null>;
	/**
	 * The scroller's only child, whose height is written here and nowhere else:
	 * a column that lays its last child, the rows, on its bottom edge.
	 */
	trackRef: RefObject<HTMLDivElement | null>;
	/** The box holding the rows, watched for the growth output causes. */
	contentRef: RefObject<HTMLDivElement | null>;
	/** What the end shows now; see `TailSignature`. */
	tail: TailSignature;
	/**
	 * Asked once in every commit, before the view is placed: whether this commit
	 * is one that puts the reader back on the tail whatever they were reading.
	 */
	returnsToTail?: () => boolean;
	/**
	 * Whether the scroller is in the document. The listener and the observers are
	 * attached again when it appears.
	 */
	hasContainer?: boolean;
	/** Bumped once per older page landing above the rows. */
	loadedHistoryPages?: number;
	/** Whether the track keeps a reserve above the rows for pages to land in. */
	hasMoreHistory?: boolean;
	/**
	 * Where the view is first placed: on the tail, following it, or at the top
	 * of the rows, read from there. Read once.
	 */
	startAt?: "end" | "top";
}

export interface TranscriptScroll {
	/**
	 * Only shown while reading somewhere else, not within reach of the end, and
	 * never over a control marked keep-clear (`keepClearProps`): at the tail it
	 * does nothing, at the end there is nothing left below to go to, and over a
	 * permission card's answers it would take the press meant for them.
	 */
	showScrollButton: boolean;
	/** The end of the conversation has changed since the reader left it. */
	hasUnseen: boolean;
	scrollToBottom: () => void;
	/**
	 * Puts `target` at the top of the view — under whatever its
	 * `scroll-margin-top` says is pinned there — and reads from there.
	 */
	jumpTo: (target: HTMLElement) => void;
	/**
	 * `jumpTo`, kept aimed at `target` while what is below it is still being
	 * drawn — a block that measures itself before it draws its content — so a
	 * target the end held short of the top is taken the rest of the way as the
	 * end moves down. Given up once there, and on any move of the reader's or
	 * of the rows' own (`holdAt`).
	 */
	readFrom: (target: HTMLElement) => void;
	/** What the rows inside the transcript move the reader with. */
	view: TranscriptView;
	/** Whether the reader is following the tail. */
	isFollowing: () => boolean;
	/** Whether the view is within reach of the end now. */
	isAtEnd: () => boolean;
	/**
	 * Stops following where the view is, as the reader scrolling away would,
	 * for a transcript taken off the screen: what arrives meanwhile is the dot.
	 */
	stopFollowing: () => void;
}

/**
 * Keeps the transcript where the reader wants it: two states, one action —
 * and, because any write to `scrollTop` ends iOS momentum scrolling, as few of
 * those writes as the action can be carried out with.
 *
 * The rows sit on the bottom edge of a track whose height is written here, so
 * where something changes decides who moves:
 *
 * - (A) Above the reader, nothing is written. What is above them moves up, into
 *   the reserve left over the rows or past the top of the track.
 * - (B) Below the reader, only the track's height is written, by as much as the
 *   reader's place moved, which puts it back without touching `scrollTop`. The
 *   anchor says where that place is — or the seam, in the commit a page lands in.
 * - (C) The track and `scrollTop` are put back in line together — the reserve
 *   restored, what went past the top brought back in reach, the reserve dropped
 *   once history has run out — only when the view is at rest (`settle`), and
 *   just before a deliberate move, which writes `scrollTop` anyway.
 *
 * Reading the tail, everything is above the reader, and the view is pinned to
 * the end.
 *
 * The action runs at exactly two moments — after every commit, before paint,
 * and on every resize of either box — and the putting right of C on a third:
 * when the view comes to rest. Everything that used to need a case of its
 * own (a diagram rendering, a card expanding, the software keyboard, the
 * container growing back when an overlay closes) is one of those two, so none
 * of them is named here. The state changes only on the reader's own scrolling,
 * decided by direction, plus the explicit returns to the tail below.
 */
export function useTranscriptScroll({
	scrollRef,
	trackRef,
	contentRef,
	tail,
	returnsToTail,
	hasContainer = true,
	loadedHistoryPages = 0,
	hasMoreHistory = false,
	startAt = "end",
}: Options): TranscriptScroll {
	const startsAtTop = useRef(startAt === "top").current;
	const stateRef = useRef<ReadingState>(startsAtTop ? "anchored" : "tail");
	const anchorRef = useRef<ScrollAnchor | null>(null);
	/**
	 * The seam as it sat the last time the view was placed or read. Kept current
	 * rather than taken when a page lands, because by the time the commit that
	 * lands it is seen here the page is already laid out above it.
	 */
	const seamRef = useRef<Seam | null>(null);
	/**
	 * The offset the view was last known to be at, which is what makes a scroll
	 * event a direction rather than a position. Our own writes update it too:
	 * they are movements, and a reader who scrolls up from where we put them has
	 * to be measured against that, not against wherever they last stopped.
	 */
	const lastTopRef = useRef(0);
	/** What `readFrom` is still taking the view to; null when nothing is. */
	const aimRef = useRef<HTMLElement | null>(null);
	const [isAnchored, setIsAnchored] = useState(startsAtTop);
	const [isNearEnd, setIsNearEnd] = useState(true);
	const [isOverKeepClear, setIsOverKeepClear] = useState(false);
	const [hasUnseen, setHasUnseen] = useState(false);
	// Read from the scroll handler, which is attached once and so cannot close
	// over `tail`; kept current by the per-commit effect below.
	const tailRef = useRef(tail);
	/** The tail as it was when the reader left it; null while reading the tail. */
	const leftTailRef = useRef<TailSignature | null>(startsAtTop ? tail : null);

	const readTail = useCallback(() => {
		aimRef.current = null;
		stateRef.current = "tail";
		anchorRef.current = null;
		leftTailRef.current = null;
		setIsAnchored(false);
		setHasUnseen(false);
	}, []);

	const readAnchored = useCallback((anchor: ScrollAnchor | null) => {
		// Only on leaving the tail: a jump made while already reading elsewhere
		// has not shown the reader the end either.
		if (stateRef.current === "tail") {
			leftTailRef.current = tailRef.current;
		}
		stateRef.current = "anchored";
		anchorRef.current = anchor;
		setIsAnchored(true);
	}, []);

	// Wherever the view comes to rest. Within reach of the end is also where the
	// end has been seen, so an anchored reader there has nothing new below them.
	const noteEnd = useCallback((el: HTMLElement) => {
		const nearEnd = maxScrollTop(el) - el.scrollTop <= AT_BOTTOM_THRESHOLD;
		setIsNearEnd(nearEnd);
		setIsOverKeepClear(keepClearInBand(el));
		if (nearEnd && stateRef.current === "anchored") {
			leftTailRef.current = tailRef.current;
			setHasUnseen(false);
		}
	}, []);

	/**
	 * Notes where the view now is: the position the next scroll event is a
	 * direction from, the seam a page landing next would be held by, and how far
	 * the end is.
	 */
	const record = useCallback(
		(el: HTMLElement) => {
			// Read back rather than assumed: the browser clamps a write, and a
			// direction compared against a position the view never reached would
			// read the next event as the reader moving.
			lastTopRef.current = el.scrollTop;
			seamRef.current = takeSeam(el);
			noteEnd(el);
		},
		[noteEnd],
	);

	const moveTo = useCallback(
		(el: HTMLElement, target: number) => {
			const clamped = Math.min(Math.max(target, 0), maxScrollTop(el));
			if (Math.abs(el.scrollTop - clamped) >= DRIFT_TOLERANCE) {
				el.scrollTop = clamped;
			}
			record(el);
		},
		[record],
	);

	/**
	 * The track's height as last written, read off its own style rather than the
	 * layout — and never shorter than the view, which `min-h-full` holds it to
	 * before the first write: a short transcript sits on the bottom.
	 */
	const trackHeight = useCallback(
		(el: HTMLElement) =>
			Math.max(
				Number.parseFloat(trackRef.current?.style.height ?? "") || 0,
				el.clientHeight,
			),
		[trackRef],
	);
	const writeTrackHeight = useCallback(
		(el: HTMLElement, height: number) => {
			const track = trackRef.current;
			if (track) track.style.height = `${Math.max(height, el.clientHeight)}px`;
		},
		[trackRef],
	);

	// Read by `settle`, which also runs from the rest timer; kept current by the
	// per-commit effect below.
	const hasMoreHistoryRef = useRef(hasMoreHistory);

	/**
	 * Kind C: the track as it should be, and `scrollTop` moved by as much as the
	 * rows moved with it, so nothing on screen moves. As it should be is the rows
	 * plus a reserve of a screen while older history remains — enough to take a
	 * page landing mid-flick without anything going out of reach — and the rows
	 * alone once it has run out.
	 */
	const settle = useCallback(
		(el: HTMLElement) => {
			const rows = contentRef.current;
			if (!rows) return;
			const reserve = hasMoreHistoryRef.current
				? Math.max(el.clientHeight, MIN_RESERVE)
				: 0;
			const before = trackHeight(el);
			const shift =
				Math.max(
					rows.getBoundingClientRect().height + reserve,
					el.clientHeight,
				) - before;
			const top = el.scrollTop;
			if (Math.abs(shift) >= DRIFT_TOLERANCE) {
				writeTrackHeight(el, before + shift);
			}
			if (stateRef.current === "tail") {
				moveTo(el, maxScrollTop(el));
			} else if (Math.abs(shift) >= DRIFT_TOLERANCE) {
				moveTo(el, top + shift);
			}
		},
		[contentRef, trackHeight, writeTrackHeight, moveTo],
	);

	const restingRef = useRef(true);
	const pressedRef = useRef(false);
	const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearRestTimer = useCallback(() => {
		if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
		restTimerRef.current = null;
	}, []);

	const leaveRest = useCallback(() => {
		restingRef.current = false;
		clearRestTimer();
	}, [clearRestTimer]);

	/** Starts the wait for rest over; see `REST_DELAY_MS`. */
	const awaitRest = useCallback(() => {
		leaveRest();
		restTimerRef.current = setTimeout(() => {
			restTimerRef.current = null;
			if (pressedRef.current) return;
			restingRef.current = true;
			const el = scrollRef.current;
			if (el) settle(el);
		}, REST_DELAY_MS);
	}, [leaveRest, scrollRef, settle]);

	/**
	 * Takes the view on towards `readFrom`'s target, as far as the end now
	 * lets it, anchored on the target where it ends up; the aim is given up
	 * once the target is where it was asked for.
	 */
	const pursueAim = useCallback(
		(el: HTMLElement) => {
			const target = aimRef.current;
			if (!target) return;
			if (!el.contains(target)) {
				aimRef.current = null;
				return;
			}
			const wanted = scrollTopFor(el, target);
			moveTo(el, wanted);
			anchorRef.current = anchorOn(el, target);
			if (Math.abs(wanted - el.scrollTop) < DRIFT_TOLERANCE) {
				aimRef.current = null;
			}
		},
		[moveTo],
	);

	/**
	 * Kinds A and B, then C if the view is at rest. Reading the tail there is no
	 * place to hold — everything is above the reader — only the end to pin.
	 *
	 * Anchored, the reader's place is the anchor; in the commit a page lands in,
	 * the seam (see `Seam`), and the anchor is taken afresh afterwards — it is
	 * not carried across the page. However far that place moved, the track's
	 * height moves it back, which only growth or shrinking *below* it can have
	 * done: the rows are laid on the track's bottom edge, so what changes above
	 * moves only what is above.
	 *
	 * The anchored element can leave the list or stop being laid out; what is
	 * left of its path holds the reader instead (see `holdingAnchor`). With
	 * nothing left, this look leaves the view where it is — which is still not a
	 * reason to go back to the tail — and the next is held by whatever it now
	 * shows.
	 */
	const hold = useCallback(
		(pageLanded: boolean) => {
			const el = scrollRef.current;
			if (!el) return;
			if (stateRef.current === "tail") {
				moveTo(el, maxScrollTop(el));
			} else {
				let moved: number | null = null;
				if (pageLanded) {
					const seam = seamRef.current;
					const top = seam && seamScrollTop(el, seam);
					if (top !== null) moved = top - el.scrollTop;
				} else {
					const taken = anchorRef.current;
					const anchor = taken && holdingAnchor(el, taken);
					anchorRef.current = anchor;
					if (anchor) moved = anchorScrollTop(el, anchor) - el.scrollTop;
				}
				if (moved !== null && Math.abs(moved) >= DRIFT_TOLERANCE) {
					// Never so short that the view would be past the new end: the
					// browser would clamp it, which is a scroll of its own, and the next
					// look would take that for the reader's place moving and shorten
					// the track again — until what is above went out of reach. Content
					// collapsing below a reader at the end moves what they see; that
					// is the end coming up, not something to hold.
					writeTrackHeight(
						el,
						Math.max(trackHeight(el) - moved, el.scrollTop + el.clientHeight),
					);
				}
				if (pageLanded) anchorRef.current = null;
				pursueAim(el);
				// A fresh one from where the view now sits, for the next look: the
				// one held was lost, or not carried across a page. Not to put this
				// look right — that is already done or cannot be — but because the
				// rows sit on the track's bottom edge, so without a place to hold,
				// every line output adds below would carry the reader up the screen.
				if (!anchorRef.current) anchorRef.current = pickAnchor(el);
				record(el);
			}
			if (restingRef.current) settle(el);
		},
		[
			scrollRef,
			moveTo,
			record,
			settle,
			trackHeight,
			writeTrackHeight,
			pursueAim,
		],
	);

	const prevPagesRef = useRef(loadedHistoryPages);
	/** Whether the view has been put where `startAt` says. */
	const placedRef = useRef(false);

	// No dependency list: every commit is a commit that can have invalidated the
	// invariant, and there is nothing to name — a child settling on a new size does
	// not pass through here at all. One effect rather than two, so that the
	// explicit inputs are read in the commit they belong to and always before the
	// invariant they change.
	useLayoutEffect(() => {
		tailRef.current = tail;
		hasMoreHistoryRef.current = hasMoreHistory;
		const prevPages = prevPagesRef.current;
		prevPagesRef.current = loadedHistoryPages;

		if (returnsToTail?.()) readTail();

		const el = scrollRef.current;
		if (!placedRef.current && el) {
			placedRef.current = true;
			if (startsAtTop) {
				// Put right first, or the top of rows taller than the view would be
				// past the top of the track, out of reach; the move is a write anyway.
				settle(el);
				moveTo(el, 0);
				anchorRef.current = pickAnchor(el);
			}
		}

		const left = leftTailRef.current;
		if (left) {
			const now = tail;
			if (loadedHistoryPages > prevPages) {
				// A page joining onto the newest row rewrites its parts with history the
				// reader is paging *towards*; nothing arrived at the end.
				leftTailRef.current = now;
			} else if (!sameSignature(left, now)) {
				setHasUnseen(true);
			}
		}

		hold(stateRef.current === "anchored" && loadedHistoryPages > prevPages);
	});

	// `hasContainer` re-attaches the listener and the observers when the scroller
	// appears — the chat's, which only exists while there are rows to put in it
	// (see `MessageList`'s early return), receiving its first message.
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasContainer triggers re-attach when the scroll container mounts
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		const handleScroll = () => {
			const top = el.scrollTop;
			const moved = top - lastTopRef.current;
			lastTopRef.current = top;
			// A write of our own was recorded as it was made and arrives here as no
			// movement at all; anything else is the view moving, so not at rest.
			if (moved !== 0) {
				// The reader moving the view: they are reading from wherever that is.
				aimRef.current = null;
				if (pressedRef.current) leaveRest();
				else awaitRest();
			}
			// Not for the scroll itself, which leaves the seam where it is in the
			// transcript: the reader may have scrolled over a layout that changed
			// since the invariant last saw it, and from here on that layout is
			// where they are — a page must not count its growth a second time.
			seamRef.current = takeSeam(el);
			const atBottom = maxScrollTop(el) - top <= AT_BOTTOM_THRESHOLD;
			noteEnd(el);

			if (stateRef.current === "tail") {
				// Upward movement that did not come to rest near the end is the
				// reader's — a drag, a wheel, find-in-page — because our own writes
				// here can only take the view down: they aim at the end, and the
				// browser has already clamped the view to it whenever the end moved
				// up. A tap moves nothing and so never arrives here at all, which is
				// the whole of root cause 1.
				if (moved < 0 && !atBottom) readAnchored(pickAnchor(el));
				return;
			}
			// Every event is the reader's from here. A restore of our own that ends up
			// here only takes the same anchor again, in the same place, which costs
			// nothing — and reaching the end has to be a movement *down*, or a card
			// collapsing below the view would clamp the view to the end and be read as
			// a return to the tail.
			if (moved > 0 && atBottom) {
				readTail();
				return;
			}
			anchorRef.current = pickAnchor(el);
		};

		// Pressed is a finger or a pen on the screen, or a mouse button held —
		// dragging the scrollbar, selecting text — and the view is not at rest
		// while it is, moving or not: the reader is about to move it. Fingers and
		// pens are told by the touch events alone, because a touch that starts a
		// scroll is a `pointercancel` the moment the browser takes it over, still
		// down.
		const press = () => {
			pressedRef.current = true;
			// The reader's hand on the view: whatever they open or move from here
			// is theirs, and an aim of `readFrom`'s must not take the view after it.
			aimRef.current = null;
			leaveRest();
		};
		const release = () => {
			if (!pressedRef.current) return;
			pressedRef.current = false;
			awaitRest();
		};
		const handleTouchEnd = (e: TouchEvent) => {
			if (e.touches.length === 0) release();
		};
		// The end of a touch goes to the node it started on, wherever that is by
		// then: a row replaced under the finger takes it out of the document, and
		// from there it reaches neither the scroller nor the window.
		const handleTouchStart = (e: TouchEvent) => {
			press();
			const target = e.target;
			if (!(target instanceof Node) || target === el) return;
			target.addEventListener("touchend", handleTouchEnd as EventListener, {
				once: true,
			});
			target.addEventListener("touchcancel", handleTouchEnd as EventListener, {
				once: true,
			});
		};
		const handlePointerDown = (e: PointerEvent) => {
			if (e.pointerType === "mouse") press();
		};
		const handlePointerUp = (e: PointerEvent) => {
			if (e.pointerType === "mouse") release();
		};
		// A mouse moving with no button down has been released, whether or not a
		// `pointerup` said so: Chromium can leave one out after a scrollbar drag.
		const handlePointerMove = (e: PointerEvent) => {
			if (pressedRef.current && e.pointerType === "mouse" && e.buttons === 0) {
				release();
			}
		};

		el.addEventListener("scroll", handleScroll, { passive: true });
		el.addEventListener("touchstart", handleTouchStart, { passive: true });
		el.addEventListener("touchend", handleTouchEnd);
		el.addEventListener("touchcancel", handleTouchEnd);
		el.addEventListener("pointerdown", handlePointerDown);
		// On the window: a button is released wherever the pointer has got to —
		// and a drag of a link or an image, or the window losing focus mid-press,
		// ends without a `pointerup` at all.
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerUp);
		window.addEventListener("pointermove", handlePointerMove, {
			passive: true,
		});
		window.addEventListener("dragend", release);
		window.addEventListener("blur", release);
		return () => {
			el.removeEventListener("scroll", handleScroll);
			el.removeEventListener("touchstart", handleTouchStart);
			el.removeEventListener("touchend", handleTouchEnd);
			el.removeEventListener("touchcancel", handleTouchEnd);
			el.removeEventListener("pointerdown", handlePointerDown);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerUp);
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("dragend", release);
			window.removeEventListener("blur", release);
			// A press this scroller saw the start of can only end on it, and a
			// scroller that is gone is not being moved: the next one starts at rest.
			if (pressedRef.current) {
				pressedRef.current = false;
				restingRef.current = true;
			}
		};
	}, [
		hasContainer,
		awaitRest,
		leaveRest,
		noteEnd,
		readAnchored,
		readTail,
		scrollRef,
	]);

	// A timer left behind would settle a list that is gone. Only the timer: under
	// StrictMode this cleanup also runs on a list that stays, which must not be
	// left believing it is never at rest.
	useLayoutEffect(() => clearRestTimer, [clearRestTimer]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: hasContainer triggers re-observe when the scroll container mounts
	useLayoutEffect(() => {
		const content = contentRef.current;
		const el = scrollRef.current;
		if (!content || !el) return;

		const observer = new ResizeObserver(() => hold(false));
		// Both boxes, because both of them move the view: the content grows as
		// output streams in and as anything inside it finishes rendering, while the
		// container shrinks under the software keyboard or a growing input box
		// without the content changing at all. A child settling on its own size — a
		// diagram, a thumbnail, a subagent body expanding itself — arrives here and
		// nowhere else, which is why this is the only other place the invariant is
		// applied from. Not the track, whose height only changes by being written
		// here.
		observer.observe(content);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasContainer, hold, contentRef, scrollRef]);

	const scrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		// The state first: what the button asks for is to read the tail again, and
		// the end it then goes to is the invariant's, not one frame's `scrollHeight`.
		// Aiming an animation at that offset is what made this button unreliable —
		// anything that finished rendering while it ran moved the end past the target
		// it had been given.
		//
		// Instant rather than smooth, because the two cannot both be had: the state
		// change commits, the invariant is applied before the next paint, and an
		// animation of ours would be the first thing it cut short.
		readTail();
		settle(el);
	}, [scrollRef, settle, readTail]);

	const jumpTo = useCallback(
		(target: HTMLElement) => {
			const el = scrollRef.current;
			if (!el) return;
			// The jump writes `scrollTop` anyway, so the track is put right first
			// and the jump measured against the layout that will stay.
			settle(el);
			// Instant, and written on the container rather than through
			// `scrollIntoView`: a smooth jump would be cut short by the first output
			// that lands during it, and `scrollIntoView` also scrolls whatever
			// contains the container, which is the app shell.
			//
			aimRef.current = null;
			moveTo(el, scrollTopFor(el, target));
			// Where it ended up, not where it was aimed: the end of the transcript
			// cannot be scrolled past, so a card near it stops short of the top edge
			// and the anchor has to say so — otherwise the next commit would keep
			// trying to take it further.
			readAnchored(anchorOn(el, target));
		},
		[scrollRef, settle, moveTo, readAnchored],
	);

	const readFrom = useCallback(
		(target: HTMLElement) => {
			const el = scrollRef.current;
			if (!el) return;
			jumpTo(target);
			aimRef.current = target;
			pursueAim(el);
		},
		[scrollRef, jumpTo, pursueAim],
	);

	const holdAt = useCallback(
		(target: HTMLElement, offset: number) => {
			const el = scrollRef.current;
			if (!el) return;
			aimRef.current = null;
			// As for a jump: the move is a write, so the track is put right first.
			settle(el);
			const wanted =
				el.scrollTop +
				target.getBoundingClientRect().top -
				el.getBoundingClientRect().top -
				offset;
			// Clamped before it is judged: the view can no more go above the top
			// than past the end, and a place out of reach either way is the
			// nearest one it can reach — at the end, the end itself.
			const reachable = Math.min(Math.max(wanted, 0), maxScrollTop(el));
			// Asked of a reader following the tail, a place the end already shows
			// is the end: the view stays there and keeps following. Only a place the
			// end cannot show — the target would sit above where it was asked for,
			// under a pinned bar or off the view — leaves the tail, and then the
			// view moves no further than that place.
			if (
				stateRef.current === "tail" &&
				reachable >= maxScrollTop(el) - DRIFT_TOLERANCE
			) {
				moveTo(el, maxScrollTop(el));
				return;
			}
			moveTo(el, reachable);
			// Anchored the way the reader's own scrolling would leave it.
			readAnchored(pickAnchor(el));
		},
		[scrollRef, settle, moveTo, readAnchored],
	);

	const view = useMemo<TranscriptView>(
		() => ({
			top: () => scrollRef.current?.getBoundingClientRect().top ?? 0,
			bottom: () => scrollRef.current?.getBoundingClientRect().bottom ?? 0,
			// From the top of the rows rather than of the track: the rows move inside
			// the track without the view scrolling, and putting the track right moves
			// the view with them, neither of which is the view moving over the rows.
			scrollTop: () => {
				const el = scrollRef.current;
				const rows = contentRef.current;
				if (!el || !rows) return 0;
				return (
					el.getBoundingClientRect().top +
					el.clientTop -
					rows.getBoundingClientRect().top
				);
			},
			coveredAbove,
			holdAt,
		}),
		[scrollRef, contentRef, holdAt],
	);

	const isFollowing = useCallback(() => stateRef.current === "tail", []);
	const isAtEnd = useCallback(() => {
		const el = scrollRef.current;
		return !el || maxScrollTop(el) - el.scrollTop <= AT_BOTTOM_THRESHOLD;
	}, [scrollRef]);
	const stopFollowing = useCallback(() => {
		const el = scrollRef.current;
		if (el && stateRef.current === "tail") readAnchored(pickAnchor(el));
	}, [scrollRef, readAnchored]);

	return {
		showScrollButton: isAnchored && !isNearEnd && !isOverKeepClear,
		hasUnseen,
		scrollToBottom,
		jumpTo,
		readFrom,
		view,
		isFollowing,
		isAtEnd,
		stopFollowing,
	};
}
