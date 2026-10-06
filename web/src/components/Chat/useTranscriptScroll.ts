import {
	type RefObject,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { Message } from "../../types/message";
import { isTypedByUser } from "../../utils/messageSource";
import {
	anchorScrollTop,
	enclosingCandidate,
	pickAnchor,
	type ScrollAnchor,
} from "./scrollAnchor";

/**
 * How close to the end counts as the end. Never asked on its own: reaching it is
 * only a return to the tail when the view got there moving *down*, or a card
 * collapsing below the reader would clamp the view to the end and be taken for
 * one.
 */
const AT_BOTTOM_THRESHOLD = 50;
/**
 * How far up from the view's bottom edge the scroll button reaches, hit area
 * included: its `bottom-3` offset, plus the coarse pointer's 44px floor, plus a
 * little air. Whatever must stay pressable is kept out of this band.
 */
const BUTTON_BAND = 60;

const KEEP_CLEAR_ATTR = "data-keep-clear";

/**
 * Marks controls the scroll button must never be drawn over — a pending
 * permission card's answers. Spread onto them: `<div {...keepClearProps}>`.
 */
export const keepClearProps = { [KEEP_CLEAR_ATTR]: "" };

/**
 * Whether anything marked keep-clear is in the band the button sits in. Asked
 * of the layout, not of the rows: what is below a card — the turn-end slot, a
 * message sent after it — moves the card in and out of the band by its height,
 * which is how a fixed "near the end" distance once let the button cover Allow.
 */
function keepClearInBand(el: HTMLElement): boolean {
	const bottom = el.getBoundingClientRect().bottom;
	for (const node of el.querySelectorAll(`[${KEEP_CLEAR_ATTR}]`)) {
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
 * Which of the two things the reader is doing. There is no third state, and
 * nothing samples where the view happens to sit to decide between them: a
 * position sample cannot tell a frame of our own following from the reader
 * leaving, which is how following used to be lost for good.
 */
type ReadingState = "tail" | "anchored";

/**
 * What the end of the conversation shows, compared by identity. The reducer
 * updates immutably, so every streamed chunk is a new `parts` array and a turn
 * failing sets `error` — but not the message object itself: an `anchorSeq`
 * backfill replaces that too, and it changes nothing anyone can see. Nor is it
 * the content's height, which also grows when an older page lands above.
 */
type TailSignature = readonly unknown[];

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

interface Options {
	scrollRef: RefObject<HTMLDivElement | null>;
	/** The box holding the rows, watched for the growth output causes. */
	contentRef: RefObject<HTMLDivElement | null>;
	messages: Message[];
	/** Bumped once per older page; a *drop* means the transcript was replaced. */
	loadedHistoryPages: number;
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
	/** Puts `target` at the top of the view and reads from there. */
	jumpTo: (target: HTMLElement) => void;
}

/**
 * Keeps the transcript where the reader wants it: two states, one action.
 *
 * The action is "apply the current state's invariant", and it runs at exactly
 * two moments — after every commit, before paint, and on every resize of either
 * box. Everything that used to need a case of its own (a page landing, a diagram
 * rendering, a card expanding, the software keyboard, the container growing back
 * when an overlay closes) is one of those two, so none of them is named here.
 * Nothing is on a timer and no height is reserved.
 *
 * The state changes only on the reader's own scrolling, decided by direction,
 * plus the explicit returns to the tail below.
 */
export function useTranscriptScroll({
	scrollRef,
	contentRef,
	messages,
	loadedHistoryPages,
}: Options): TranscriptScroll {
	const stateRef = useRef<ReadingState>("tail");
	const anchorRef = useRef<ScrollAnchor | null>(null);
	/**
	 * The offset the view was last known to be at, which is what makes a scroll
	 * event a direction rather than a position. Our own writes update it too:
	 * they are movements, and a reader who scrolls up from where we put them has
	 * to be measured against that, not against wherever they last stopped.
	 */
	const lastTopRef = useRef(0);
	const [isAnchored, setIsAnchored] = useState(false);
	const [isNearEnd, setIsNearEnd] = useState(true);
	const [isOverKeepClear, setIsOverKeepClear] = useState(false);
	const [hasUnseen, setHasUnseen] = useState(false);
	// Read from the scroll handler, which is attached once and so cannot close
	// over `messages`; kept current by the per-commit effect below.
	const messagesRef = useRef(messages);
	/** The tail as it was when the reader left it; null while reading the tail. */
	const leftTailRef = useRef<TailSignature | null>(null);

	const readTail = useCallback(() => {
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
			leftTailRef.current = tailSignature(messagesRef.current);
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
			leftTailRef.current = tailSignature(messagesRef.current);
			setHasUnseen(false);
		}
	}, []);

	const moveTo = useCallback(
		(el: HTMLElement, target: number) => {
			const clamped = Math.min(Math.max(target, 0), maxScrollTop(el));
			if (Math.abs(el.scrollTop - clamped) >= DRIFT_TOLERANCE) {
				el.scrollTop = clamped;
			}
			// Read back rather than assumed: the browser clamps the write, and a
			// direction compared against a position the view never reached would
			// read the next event as the reader moving.
			lastTopRef.current = el.scrollTop;
			noteEnd(el);
		},
		[noteEnd],
	);

	const applyInvariant = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (stateRef.current === "tail") {
			moveTo(el, maxScrollTop(el));
			return;
		}
		let anchor = anchorRef.current;
		// The anchored element can leave the list: a page spliced its row into
		// another, a tool row was replaced by the card that took its place. Taking a
		// fresh anchor for where the view is now keeps the reader where they are,
		// which is why losing an anchor is not a reason to go back to the tail.
		if (!anchor || !el.contains(anchor.el)) {
			anchor = pickAnchor(el);
			anchorRef.current = anchor;
			if (!anchor) return;
		}
		moveTo(el, anchorScrollTop(anchor));
	}, [scrollRef, moveTo]);

	// The rows of the previous commit, read by id: what makes a message "just
	// sent" is that it was not there a commit ago, and a count cannot say that — an
	// older page landing above grows the list without adding anything at the end,
	// and it routinely lands under a transcript whose newest row is one the reader
	// typed.
	const prevMessagesRef = useRef(messages);
	const prevPagesRef = useRef(loadedHistoryPages);

	// No dependency list: every commit is a commit that can have invalidated the
	// invariant, and there is nothing to name — a child settling on a new size does
	// not pass through here at all. One effect rather than two, so that the
	// explicit inputs are read in the commit they belong to and always before the
	// invariant they change.
	useLayoutEffect(() => {
		messagesRef.current = messages;
		const prevPages = prevPagesRef.current;
		prevPagesRef.current = loadedHistoryPages;
		const prevMessages = prevMessagesRef.current;
		prevMessagesRef.current = messages;
		const added = rowsAdded(prevMessages, messages);

		if (
			loadedHistoryPages < prevPages ||
			(added === "replaced" && loadedHistoryPages === prevPages)
		) {
			// The transcript was replaced, which only a reconnect does: re-subscribing
			// lands back on the newest page. Paging starting over says so when pages
			// had been loaded; with none, the count cannot drop, but replaying history
			// mints every row a new id. The rows an anchor names are gone or at
			// offsets it was never measured against, and the newest page is what was
			// asked for.
			readTail();
		} else if (added !== "replaced" && added.some(isTypedByUser)) {
			// Sending is the reader saying where they are reading next; they have just
			// written at the end of the conversation. Any new row, not only the last:
			// a message sent to an idle agent lands with its reply's placeholder
			// below it. Rows nobody typed — Pockode's own, another agent's answer to a
			// posted question — are nobody's gesture and say nothing about that.
			readTail();
		}

		const left = leftTailRef.current;
		if (left) {
			const now = tailSignature(messages);
			if (loadedHistoryPages > prevPages) {
				// A page joining onto the newest row rewrites its parts with history the
				// reader is paging *towards*; nothing arrived at the end.
				leftTailRef.current = now;
			} else if (!sameSignature(left, now)) {
				setHasUnseen(true);
			}
		}

		applyInvariant();
	});

	// The scroll container only exists while there are rows to put in it (see
	// `MessageList`'s early return), so this is what re-attaches the listener and
	// the observers when it appears — a transcript that starts empty and receives
	// its first message.
	const hasContainer = messages.length > 0;

	// biome-ignore lint/correctness/useExhaustiveDependencies: hasContainer triggers re-attach when the scroll container mounts
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		const handleScroll = () => {
			const top = el.scrollTop;
			const moved = top - lastTopRef.current;
			lastTopRef.current = top;
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

		el.addEventListener("scroll", handleScroll, { passive: true });
		return () => el.removeEventListener("scroll", handleScroll);
	}, [hasContainer, noteEnd, readAnchored, readTail, scrollRef]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: hasContainer triggers re-observe when the scroll container mounts
	useLayoutEffect(() => {
		const content = contentRef.current;
		const el = scrollRef.current;
		if (!content || !el) return;

		const observer = new ResizeObserver(applyInvariant);
		// Both boxes, because both of them move the view: the content grows as
		// output streams in and as anything inside it finishes rendering, while the
		// container shrinks under the software keyboard or a growing input box
		// without the content changing at all. A child settling on its own size — a
		// diagram, a thumbnail, a subagent body expanding itself — arrives here and
		// nowhere else, which is why this is the only other place the invariant is
		// applied from.
		observer.observe(content);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasContainer, applyInvariant, contentRef, scrollRef]);

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
		moveTo(el, maxScrollTop(el));
	}, [scrollRef, moveTo, readTail]);

	const jumpTo = useCallback(
		(target: HTMLElement) => {
			const el = scrollRef.current;
			if (!el) return;
			// Instant, and written on the container rather than through
			// `scrollIntoView`: a smooth jump would be cut short by the first output
			// that lands during it, and `scrollIntoView` also scrolls whatever
			// contains the container, which is the app shell.
			const anchored = enclosingCandidate(target);
			moveTo(el, anchored.offsetTop);
			// Where it ended up, not where it was aimed: the end of the transcript
			// cannot be scrolled past, so a card near it stops short of the top edge
			// and the anchor has to say so — otherwise the next commit would keep
			// trying to take it further.
			readAnchored({ el: anchored, offset: anchored.offsetTop - el.scrollTop });
		},
		[scrollRef, moveTo, readAnchored],
	);

	return {
		showScrollButton: isAnchored && !isNearEnd && !isOverKeepClear,
		hasUnseen,
		scrollToBottom,
		jumpTo,
	};
}
