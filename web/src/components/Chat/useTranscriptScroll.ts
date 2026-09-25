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
	/** Only shown while reading somewhere else: at the tail it does nothing. */
	showScrollButton: boolean;
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
	const [showScrollButton, setShowScrollButton] = useState(false);

	const readTail = useCallback(() => {
		stateRef.current = "tail";
		anchorRef.current = null;
		setShowScrollButton(false);
	}, []);

	const readAnchored = useCallback((anchor: ScrollAnchor | null) => {
		stateRef.current = "anchored";
		anchorRef.current = anchor;
		setShowScrollButton(true);
	}, []);

	const moveTo = useCallback((el: HTMLElement, target: number) => {
		const clamped = Math.min(Math.max(target, 0), maxScrollTop(el));
		if (Math.abs(el.scrollTop - clamped) >= DRIFT_TOLERANCE) {
			el.scrollTop = clamped;
		}
		// Read back rather than assumed: the browser clamps the write, and a
		// direction compared against a position the view never reached would read
		// the next event as the reader moving.
		lastTopRef.current = el.scrollTop;
	}, []);

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

	// The newest row, by id: what makes a message "just sent" is that it was not
	// there a commit ago, and a count cannot say that — an older page landing above
	// grows the list without adding anything at the end, and it routinely lands
	// under a transcript whose newest row is one the reader typed.
	const prevLastIdRef = useRef(messages[messages.length - 1]?.id);
	const prevPagesRef = useRef(loadedHistoryPages);

	// No dependency list: every commit is a commit that can have invalidated the
	// invariant, and there is nothing to name — a child settling on a new size does
	// not pass through here at all. One effect rather than two, so that the
	// explicit inputs are read in the commit they belong to and always before the
	// invariant they change.
	useLayoutEffect(() => {
		const prevPages = prevPagesRef.current;
		prevPagesRef.current = loadedHistoryPages;
		const last = messages[messages.length - 1];
		const prevLastId = prevLastIdRef.current;
		prevLastIdRef.current = last?.id;

		if (loadedHistoryPages < prevPages) {
			// Paging started over, which only a reconnect does: re-subscribing lands
			// back on the newest page and replaces the transcript. The rows an anchor
			// names may be in there at offsets it was never measured against, and the
			// newest page is what was asked for.
			readTail();
		} else if (last && last.id !== prevLastId && isTypedByUser(last)) {
			// Sending is the reader saying where they are reading next; they have just
			// written at the end of the conversation. Rows nobody typed — Pockode's
			// own, another agent's answer to a posted question — are nobody's gesture
			// and say nothing about that.
			readTail();
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
	}, [hasContainer, readAnchored, readTail, scrollRef]);

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

	return { showScrollButton, scrollToBottom, jumpTo };
}
