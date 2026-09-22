import { ArrowDown } from "lucide-react";
import {
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { openAssistantIndex } from "../../lib/messageReducer";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import type { Message, PermissionRequest } from "../../types/message";
import { isTypedByUser } from "../../utils/messageSource";
import { Spinner } from "../ui";
import ForkOriginBanner from "./ForkOriginBanner";
import MessageItem, {
	type PermissionChoice,
	type PromptError,
} from "./MessageItem";

const AT_BOTTOM_THRESHOLD = 50;
const HIGHLIGHT_DURATION_MS = 1500;
/**
 * How long a restored page keeps being corrected after it lands. The restore is
 * measured the moment the page is committed, and what it measures is not final:
 * syntax highlighting, a diagram and an image all settle a few frames later and
 * each of them changes a height the restore was computed from. Long enough to
 * cover those, short enough that a correction can never land on a view the user
 * has since moved somewhere themselves.
 */
const RESTORE_SETTLE_MS = 500;
const HIGHLIGHT_CLASS = "jump-highlight";

// Attribute lookup rather than a `[data-...="id"]` selector so request ids never
// need CSS escaping.
//
// A permission request is the only kind of card this reaches, because it is the
// only thing left that holds a turn up and therefore the only thing the strip
// names by request id. A posted question is reached by the answer panel instead,
// which is where answering happens — there is deliberately no jump to a question
// card (docs/answering-ui.md §8).
function findRequestCard(
	root: HTMLElement,
	requestId: string,
): HTMLElement | null {
	for (const card of root.querySelectorAll<HTMLElement>(
		"[data-permission-request-id]",
	)) {
		if (card.dataset.permissionRequestId === requestId) return card;
	}
	return null;
}

function findMessageElement(
	root: HTMLElement,
	messageId: string,
): HTMLElement | null {
	for (const el of root.querySelectorAll<HTMLElement>("[data-message-id]")) {
		if (el.dataset.messageId === messageId) return el;
	}
	return null;
}

interface ScrollAnchor {
	messageId: string;
	offsetTop: number;
	scrollTop: number;
	/** The container's height when this was last measured; see the restore. */
	scrollHeight: number;
	/** Where the anchored row sat in the list; see `madeProgress`. */
	rowIndex: number;
}

/**
 * Pins the view to a row that an incoming page cannot rewrite under it.
 *
 * The second row rather than the first: when the older page's last message and
 * the loaded transcript's first one are two halves of one assistant turn they
 * are spliced into a single bubble, and that bubble keeps the *first* one's
 * identity (see `prependHistoryPage`). Holding its top edge still therefore
 * holds nothing still — the older half grows inside it and pushes everything
 * the reader was looking at down, which is the jump the anchor exists to
 * prevent. Only `messages[0]` can be merged into that way, so the row below it
 * is a fixed point, and holding that one holds the first row's own content
 * still as well.
 *
 * A transcript of one message has no row below it and is pinned to that one
 * instead. It is also far shorter than the viewport, so there is no view
 * position for a merge to lose there.
 */
function measureAnchor(el: HTMLElement): ScrollAnchor | null {
	const rows = el.querySelectorAll<HTMLElement>("[data-message-id]");
	const rowIndex = rows.length > 1 ? 1 : 0;
	const row = rows[rowIndex];
	const messageId = row?.dataset.messageId;
	if (!messageId) return null;
	return {
		messageId,
		offsetTop: row.offsetTop,
		scrollTop: el.scrollTop,
		scrollHeight: el.scrollHeight,
		rowIndex,
	};
}

/**
 * Puts the view back over the message the anchor was pinned to. False when that
 * message is no longer in the list, which the caller has to answer for.
 */
function restoreToAnchor(el: HTMLElement, anchor: ScrollAnchor): boolean {
	const anchored = findMessageElement(el, anchor.messageId);
	if (!anchored) return false;
	el.scrollTop = anchor.scrollTop + (anchored.offsetTop - anchor.offsetTop);
	return true;
}

/**
 * Whether the page that just landed got anywhere — the one thing that has to be
 * true before the next one may be asked for.
 *
 * Normally that means the view is further down than it was, which is the same
 * thing as the sentinel having been pushed up and away. Until the transcript
 * fills the viewport, though, there is nothing to scroll at all (the content box
 * carries `min-h-full`) and nothing else moves either: the rows sit on the bottom
 * edge (`justify-end`), so a page fills space that was empty above them and
 * leaves every height and offset below it exactly as it was. The only thing that
 * changes there is how many rows sit above the anchored one, which an empty page
 * leaves alone.
 */
function madeProgress(el: HTMLElement, anchor: ScrollAnchor): boolean {
	if (el.scrollHeight > el.clientHeight) return el.scrollTop > anchor.scrollTop;
	const rows = [...el.querySelectorAll<HTMLElement>("[data-message-id]")];
	// A row that is gone is not progress: the restore fell back to the height the
	// container gained, which in this branch it gained none of.
	return (
		rows.findIndex((row) => row.dataset.messageId === anchor.messageId) >
		anchor.rowIndex
	);
}

function isAtBottom(el: HTMLElement): boolean {
	return (
		el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD
	);
}

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * What the transcript can be asked to do from outside it.
 *
 * Jumping to a card is scroll work, and the scroll container lives here — so the
 * attention strip, which sits below the list, asks rather than reimplements. It
 * is the only caller, and a permission card is the only thing it can reach
 * (`findRequestCard`).
 */
export interface MessageListHandle {
	jumpToRequest: (requestId: string) => void;
}

interface Props {
	ref?: Ref<MessageListHandle>;
	messages: Message[];
	/** The session this transcript belongs to; see `MessageItem`. */
	sessionId: string;
	/** Whether the server still holds records older than `messages[0]`. */
	hasMoreHistory?: boolean;
	isLoadingMoreHistory?: boolean;
	historyError?: string | null;
	/** Bumped once per older page loaded; see `useChatMessages`. */
	loadedHistoryPages?: number;
	onLoadMoreHistory?: () => void;
	isCodex?: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	/** Sends a message; used by the empty state's hints. */
	onHintClick?: (hint: string) => void;
	/** Opens the answer panel on one question; see `QuestionRecordItem`. */
	onAnswerQuestion?: (requestId: string) => void;
	promptError?: PromptError;
	onOpenWorkDetail?: (workId: string) => void;
	/** Opens a work-directory file in the Files viewer. Must be stable. */
	onOpenFile?: (path: string) => void;
	/** The session this one was forked from, if it was. */
	forkedFromSessionId?: string;
	onOpenSession?: (sessionId: string) => void;
	/** Must be stable: it reaches the memoized `MessageItem`. */
	onForkMessage?: (messageId: string) => void;
	/**
	 * The transcript belongs to another worktree and can only be read. Only the
	 * empty state needs telling: everything else here already goes quiet when
	 * the handler it would call is withheld.
	 */
	isReadOnly?: boolean;
}

function MessageList({
	ref,
	messages,
	sessionId,
	hasMoreHistory = false,
	isLoadingMoreHistory = false,
	historyError = null,
	loadedHistoryPages = 0,
	onLoadMoreHistory,
	isCodex,
	onPermissionRespond,
	onAnswerQuestion,
	onHintClick,
	promptError,
	onOpenWorkDetail,
	onOpenFile,
	forkedFromSessionId,
	onOpenSession,
	onForkMessage,
	isReadOnly = false,
}: Props) {
	const { EmptyState: CustomEmptyState } = useChatUIConfig();
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const [showScrollButton, setShowScrollButton] = useState(false);
	/**
	 * Whether the view should stay pinned to the tail. This is the user's intent,
	 * not a sample of where the view currently sits: the user scrolling off the
	 * tail clears it, and their scrolling back to it, the scroll-to-bottom button,
	 * or sending a message sets it again. A position sample cannot stand in for
	 * it, because a programmatic smooth scroll dispatches the same scroll events
	 * as a drag and every frame of one reads as "not at bottom".
	 */
	const followRef = useRef(true);
	/**
	 * Whether the scrolling now in progress is the user's. Set by the gestures
	 * that scroll the container, and dropped both when a gesture comes to rest at
	 * the tail and whenever we start a scroll of our own — those declare the
	 * intent themselves and must not have it overwritten by where they land. It
	 * has to outlive the gesture rather than be paired with it tick by tick:
	 * gesture events arrive before the scrolling they cause, and iOS momentum
	 * goes on scrolling long after the last `touchmove`.
	 */
	const userScrolledRef = useRef(false);
	// Where the view sits over the transcript while an older page is on its way,
	// pinned to a message (see `measureAnchor`) and re-taken on every scroll until
	// the page lands. A height difference would not do: the agent can go on
	// writing at the bottom while the page is in flight, and that growth is
	// indistinguishable from the growth above that has to be compensated for.
	const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
	// The anchor of the page that has landed but not settled yet, kept past the
	// restore so the correction can be repeated as the page finishes rendering.
	const restoreRef = useRef<ScrollAnchor | null>(null);
	const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/**
	 * Whether paging has stopped because the last page left the view where it
	 * was. Nothing re-arms the sentinel while this is set, which is what makes the
	 * runaway impossible; a gesture from the user starts it again.
	 */
	const pagingStalledRef = useRef(false);
	/**
	 * Bumped to re-observe the sentinel. Deliberately not `loadedHistoryPages`:
	 * re-observing on the page itself is what produced the loop, because a fresh
	 * observer reports a sentinel that is still on screen straight away, and a
	 * restore that moved nothing leaves it exactly there.
	 */
	const [sentinelArmKey, setSentinelArmKey] = useState(0);
	// Mirrors the prop rather than closing over it: `requestOlderPage` must keep
	// its identity, or the sentinel effect below would re-observe — that is, re-arm
	// — every time a page starts or finishes loading.
	const isLoadingMoreRef = useRef(isLoadingMoreHistory);
	useEffect(() => {
		isLoadingMoreRef.current = isLoadingMoreHistory;
	}, [isLoadingMoreHistory]);

	const cancelRestoreWindow = useCallback(() => {
		restoreRef.current = null;
		if (restoreTimerRef.current !== null) {
			clearTimeout(restoreTimerRef.current);
			restoreTimerRef.current = null;
		}
	}, []);

	// A window left open outlives the transcript it belongs to: its timer would
	// come back to a tree that has been unmounted or switched to another session.
	useEffect(() => cancelRestoreWindow, [cancelRestoreWindow]);

	/**
	 * Gives up on the page that landed because something else now owns the view —
	 * a gesture, or a scroll started here with an intent of its own. Correcting
	 * from here would pull the view off wherever it was deliberately taken, and
	 * whether that page helped can no longer be told, so paging waits to be asked
	 * again instead of deciding for itself.
	 */
	const abandonRestoreWindow = useCallback(() => {
		if (!restoreRef.current) return;
		cancelRestoreWindow();
		pagingStalledRef.current = true;
	}, [cancelRestoreWindow]);

	/**
	 * The gate that makes the paging loop impossible: the next page may only be
	 * asked for once the one that landed got somewhere (see `madeProgress`). A
	 * page that got nowhere — an empty one, or one whose restore failed — leaves
	 * the sentinel on screen, and arming again there is precisely the tight loop
	 * this exists to prevent.
	 */
	const closeRestoreWindow = useCallback(() => {
		const anchor = restoreRef.current;
		const el = scrollRef.current;
		cancelRestoreWindow();
		if (!anchor || !el) return;

		if (madeProgress(el, anchor)) {
			// A page that did not fill the viewport leaves the sentinel in view, and
			// the fresh observer reports that immediately: paging goes on, one page
			// per settled restore, until the view has something to move over.
			setSentinelArmKey((key) => key + 1);
			return;
		}

		pagingStalledRef.current = true;
		console.warn(
			"Earlier page left the view where it was; paused loading more until the reader scrolls again",
		);
	}, [cancelRestoreWindow]);

	const totalCount = messages.length;
	// Which bubble the open turn is writing into, so a reply can say it is still
	// being written wherever it sits. Position stopped answering that when a
	// message sent mid-reply began landing *below* the reply it went into
	// (docs/lifecycle-ui.md §2.3): the last row is then the message, not the turn.
	const openIndex = openAssistantIndex(messages);
	// Scroll container is only mounted when messages are non-empty (see early return below).
	// Effects that attach to the container must re-run on this transition.
	const hasMessages = totalCount > 0;

	// Keep the button and the follow intent in step with the view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasMessages triggers re-attach when scroll container mounts
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		const noteGesture = () => {
			userScrolledRef.current = true;
			// The user is steering now, so the page that just landed stops being
			// corrected.
			if (restoreRef.current) {
				abandonRestoreWindow();
				return;
			}
			// Paging stopped because the last page moved nothing. Asking for more by
			// hand is what starts it again — bounded by the reader's gestures, which
			// is the whole difference from the loop this replaces.
			if (pagingStalledRef.current) {
				pagingStalledRef.current = false;
				setSentinelArmKey((key) => key + 1);
			}
		};

		const handleScroll = () => {
			const atBottom = isAtBottom(el);
			setShowScrollButton(!atBottom);
			// A page in flight is restored against the view as it is when the page
			// lands, not as it was when it was asked for. Nothing stops the reader
			// scrolling in between — a flick that reaches the top asks for the page
			// and then goes on travelling — and restoring to where that flick started
			// is a yank backwards over content they have already read past.
			//
			// The whole pin is taken again, not just the scroll offset. A late event
			// can still grow a message above the pinned row while the page is on its
			// way, and a scroll after that would otherwise pair a fresh offset with a
			// stale one, counting that growth twice when the page lands. Free to
			// re-measure here: `isAtBottom` above has already flushed layout, and
			// nothing between the two writes to the DOM.
			if (scrollAnchorRef.current) scrollAnchorRef.current = measureAnchor(el);
			// Only the user's own scrolling moves the intent, because only it *is*
			// the intent. Every programmatic scroll already carries one, declared
			// where it is started, and would otherwise overwrite it on arrival: the
			// jump to a question that happens to land near the end of the transcript
			// would resume following and let the next reflow drag that question
			// straight back off the screen.
			if (!userScrolledRef.current) return;
			followRef.current = atBottom;
			// Coming to rest at the tail settles the gesture; anything after it has
			// to be a fresh one. A gesture that ends elsewhere stays armed, because
			// momentum can still be carrying it.
			if (atBottom) userScrolledRef.current = false;
		};

		el.addEventListener("scroll", handleScroll, { passive: true });
		// The gestures that can scroll this container. `pointerdown` covers both
		// dragging the scrollbar and the start of a touch drag. A tap that never
		// scrolls cannot move the follow intent — that is only read once a scroll
		// event reports where the gesture left the view — but it does end a restore
		// in progress, which costs at most the automatic continuation of one page.
		el.addEventListener("wheel", noteGesture, { passive: true });
		el.addEventListener("touchmove", noteGesture, { passive: true });
		el.addEventListener("pointerdown", noteGesture, { passive: true });
		el.addEventListener("keydown", noteGesture);
		return () => {
			el.removeEventListener("scroll", handleScroll);
			el.removeEventListener("wheel", noteGesture);
			el.removeEventListener("touchmove", noteGesture);
			el.removeEventListener("pointerdown", noteGesture);
			el.removeEventListener("keydown", noteGesture);
		};
	}, [hasMessages, abandonRestoreWindow]);

	// Every request that starts re-pins the anchor, so a page that failed cannot
	// leave a stale one behind for the retry to restore to. Nothing is asked for
	// while a page is in flight or still settling: the page on its way owns the
	// anchor and would be restored against a view measured after it was asked
	// for, and a page not yet judged has not earned the next one (see
	// `closeRestoreWindow`).
	//
	// A second gate after the one-page-per-arming one below, because the pin is
	// what is really being guarded here, not the request. The hook drops a request
	// of its own accord too — it is already loading, or there is no cursor left —
	// and a dropped request that had re-pinned on its way in would leave the page
	// actually in flight restored against a view it was never measured over.
	const requestOlderPage = useCallback(() => {
		if (isLoadingMoreRef.current || restoreRef.current) return;
		const scrollEl = scrollRef.current;
		if (scrollEl) scrollAnchorRef.current = measureAnchor(scrollEl);
		onLoadMoreHistory?.();
	}, [onLoadMoreHistory]);

	// A page that failed never lands, so its anchor has nothing left to be
	// restored against. Dropping it keeps "an anchor is pending" and "a page is on
	// its way" the same fact, which is what the scroll handler above re-measures
	// on; the retry pins a fresh one.
	useEffect(() => {
		if (historyError) scrollAnchorRef.current = null;
	}, [historyError]);

	// Re-created whenever paging is armed again — see `sentinelArmKey` — so a page
	// that did not fill the viewport still leads to the next one; skipped entirely
	// once a page has failed, since the sentinel does not move and the observer
	// would retry in a tight loop behind the user's back.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sentinelArmKey is an intentional trigger to re-observe once a restore has settled
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const scrollEl = scrollRef.current;
		if (!sentinel || !scrollEl || !hasMoreHistory || historyError) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries[0].isIntersecting) return;
				// One page per arming. Left watching, this observer reports every
				// later crossing of the top edge too — and the corrections a landing
				// page makes while it settles move the sentinel across that edge
				// repeatedly, each crossing asking for a page nothing has judged the
				// need for. Re-arming is the only way on, and only a restore that got
				// somewhere re-arms. Safe to drop even when the request below is
				// refused: whatever refused it — a page in flight, a page still
				// settling — re-arms or stalls on its own, and a stall ends at the
				// reader's next gesture.
				observer.disconnect();
				requestOlderPage();
			},
			{ root: scrollEl, threshold: 0 },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMoreHistory, historyError, sentinelArmKey, requestOlderPage]);

	// Hold the view still over the messages that were already on screen after an
	// older page is spliced in above them.
	const prevTotalCountRef = useRef(totalCount);
	const prevLoadedPagesRef = useRef(loadedHistoryPages);
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedHistoryPages is the trigger — it marks the commit that prepended a page
	useLayoutEffect(() => {
		const prevPages = prevLoadedPagesRef.current;
		prevLoadedPagesRef.current = loadedHistoryPages;
		const anchor = scrollAnchorRef.current;
		const el = scrollRef.current;
		scrollAnchorRef.current = null;
		// Only a page count that went *up* is a page landing above the view.
		// Paging can also start over: a reconnect re-subscribes and lands back on
		// the newest page, replacing the transcript the anchor was measured
		// against, and restoring against whatever took its place drops the reader
		// at an offset that means nothing. A session switch cannot get here — this
		// list is keyed on the session and remounts — so a reconnect is the whole
		// of it.
		if (loadedHistoryPages <= prevPages) return;
		if (!anchor || !el) return;

		// Runs before the follow-the-tail effect below, and tells it this commit
		// added nothing at the bottom: a prepend is not new content to follow.
		prevTotalCountRef.current = totalCount;

		if (!restoreToAnchor(el, anchor)) {
			// Never silently: with the anchor row gone there is nothing to measure
			// against, and the view would simply stay at the top — which is the one
			// state that asks for page after page. Falling back to the height the
			// container gained is cruder (the agent may have been writing at the
			// bottom meanwhile, and that growth counts here too), but it moves the
			// view off the sentinel, and the gate below judges whether it did.
			console.warn(
				`Lost the scroll anchor (message ${anchor.messageId}), restoring the view by height instead`,
			);
			el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
		}

		// The restore above was measured against a page that has not finished
		// rendering. Keep correcting it until it has.
		cancelRestoreWindow();
		restoreRef.current = anchor;
		restoreTimerRef.current = setTimeout(closeRestoreWindow, RESTORE_SETTLE_MS);
	}, [loadedHistoryPages]);

	// Initial scroll to bottom (before paint)
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasMessages triggers scroll when container first mounts
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [hasMessages]);

	// Scroll to bottom when new messages are added (e.g. user sends a message).
	// ResizeObserver alone is not reliable here: it fires asynchronously, and
	// followRef may become stale by that time. useLayoutEffect fires
	// synchronously after DOM commit, so it captures followRef before any
	// async events can modify it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: totalCount is the trigger — messages is read for the one row this commit appended
	useLayoutEffect(() => {
		const prev = prevTotalCountRef.current;
		prevTotalCountRef.current = totalCount;
		if (totalCount <= prev) return;

		// Sending a message is an explicit return to the tail: the user has just
		// written at the end of the conversation, so that is where they are reading
		// next, even if they had scrolled away. Rows nobody typed — Pockode's own,
		// another agent's answer — are nobody's gesture and say nothing about
		// intent.
		const last = messages[totalCount - 1];
		if (isTypedByUser(last)) {
			followRef.current = true;
			userScrolledRef.current = false;
			setShowScrollButton(false);
			abandonRestoreWindow();
		}

		const el = scrollRef.current;
		if (el && followRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [totalCount]);

	// Auto-scroll on content growth (streaming text within existing messages)
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasMessages triggers re-observe when scroll container mounts
	useEffect(() => {
		const content = contentRef.current;
		const scrollEl = scrollRef.current;
		if (!content || !scrollEl) return;

		const observer = new ResizeObserver(() => {
			// A page still settling owns the view: the reader asked for the history
			// above, and every height that lands inside it has to be compensated for
			// again, or the view drifts off what the restore put in front of them.
			const restoring = restoreRef.current;
			if (restoring) {
				restoreToAnchor(scrollEl, restoring);
				return;
			}
			if (followRef.current) {
				scrollEl.scrollTop = scrollEl.scrollHeight;
			}
		});

		observer.observe(content);
		// The container is watched as well as its content: the input box grows as
		// it is typed into, an error bar can appear above it, and the software
		// keyboard takes half the screen. None of that changes the content's
		// height, yet all of it pushes the tail out of view. A transcript shorter
		// than the viewport is held down by `min-h-full` + `justify-end` below
		// instead (`78d8d81`, re-derived in `85c0a9a`); this is the other half.
		observer.observe(scrollEl);
		return () => observer.disconnect();
	}, [hasMessages]);

	const highlightRef = useRef<{
		card: HTMLElement;
		timer: ReturnType<typeof setTimeout>;
	} | null>(null);

	// Both the class and its removal timer have to go together: dropping only the
	// timer would strand the ring on that card for good.
	const clearHighlight = useCallback(() => {
		const current = highlightRef.current;
		if (!current) return;
		clearTimeout(current.timer);
		current.card.classList.remove(HIGHLIGHT_CLASS);
		highlightRef.current = null;
	}, []);

	useEffect(() => clearHighlight, [clearHighlight]);

	const scrollToRequest = useCallback(
		(requestId: string) => {
			const scrollEl = scrollRef.current;
			if (!scrollEl) return;
			const card = findRequestCard(scrollEl, requestId);
			if (!card) return;

			// Jumping is a deliberate move away from the tail, and following stays
			// off until the user asks for it back. Without dropping the flag first,
			// the auto-follow would undo the jump: the next reflow of
			// streaming output reaches the ResizeObserver while `followRef` is still
			// set (scroll events from the smooth scroll have not been dispatched yet)
			// and snaps back to the bottom. The gesture flag is dropped along with
			// it: the scrolling from here on is this jump's, not the user's, so its
			// arrival must not be read as them choosing where to stop.
			followRef.current = false;
			userScrolledRef.current = false;
			setShowScrollButton(true);
			// This jump is where the view is meant to be now, so a page still
			// settling above does not get to correct it back.
			abandonRestoreWindow();

			card.scrollIntoView({
				block: "start",
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});

			clearHighlight();
			card.classList.add(HIGHLIGHT_CLASS);
			highlightRef.current = {
				card,
				timer: setTimeout(() => {
					card.classList.remove(HIGHLIGHT_CLASS);
					highlightRef.current = null;
				}, HIGHLIGHT_DURATION_MS),
			};

			// preventScroll: the browser's own focus scroll would fight the smooth
			// scroll started above.
			//
			// The card's first button is the row that opens it, which is as close as
			// a permission card has to a header. Without moving the focus, the jump
			// is one a keyboard user cannot perceive.
			card.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
		},
		[clearHighlight, abandonRestoreWindow],
	);

	useImperativeHandle(ref, () => ({ jumpToRequest: scrollToRequest }), [
		scrollToRequest,
	]);

	const handleScrollToBottom = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;

		// Following is restored first so that the effects above own the endpoint as
		// the content settles. Scrolling to the scrollHeight of this one frame is
		// what made the button unreliable: anything that finishes rendering during
		// the animation — syntax highlighting, a diagram, an image — moves the
		// bottom past the target the animation was given.
		followRef.current = true;
		userScrolledRef.current = false;
		setShowScrollButton(false);
		abandonRestoreWindow();

		el.scrollTo({
			top: el.scrollHeight,
			behavior: prefersReducedMotion() ? "auto" : "smooth",
		});
	}, [abandonRestoreWindow]);

	// Only once the whole transcript is loaded: pinned above a page that is still
	// the middle of a conversation, the banner would claim a position it does not
	// have.
	const forkBanner =
		!hasMoreHistory && forkedFromSessionId && onOpenSession ? (
			<ForkOriginBanner
				parentSessionId={forkedFromSessionId}
				onOpenParent={onOpenSession}
			/>
		) : null;

	if (messages.length === 0) {
		// An invitation on a screen with no composer is worse than no line at
		// all: the bar below has just said this conversation cannot be added to.
		if (isReadOnly) {
			return (
				<div className="flex min-h-0 flex-1 items-center justify-center text-th-text-muted">
					<p>Nothing was said in this conversation.</p>
				</div>
			);
		}
		if (CustomEmptyState) {
			return <CustomEmptyState onHintClick={onHintClick} />;
		}
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center text-th-text-muted">
				<p>Start a conversation...</p>
			</div>
		);
	}

	return (
		<div className="relative min-h-0 flex-1 overflow-hidden">
			{/* Browser scroll anchoring is off because the anchoring here is written
			    by hand: left on, it rewrites scrollTop under the paging restore and
			    the follow effects, and Safari does not implement it at all, so the
			    two would not even disagree the same way on each platform. */}
			<div
				ref={scrollRef}
				className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
			>
				<div
					ref={contentRef}
					className="flex min-h-full flex-col justify-end px-3 sm:px-4"
				>
					{historyError ? (
						<div
							role="alert"
							className="flex flex-wrap items-center justify-center gap-2 py-2 text-th-error text-xs"
						>
							<span>{historyError}</span>
							<button
								type="button"
								onClick={requestOlderPage}
								className="touch-target rounded px-1 underline transition-colors hover:text-th-text-primary"
							>
								Retry
							</button>
						</div>
					) : (
						hasMoreHistory && (
							// A fixed height, not padding around the spinner: this row sits
							// above everything the reader is looking at, so growing it as
							// the spinner appears pushes the whole transcript down — a
							// jump at the moment paging starts that no restore covers,
							// because no page has landed yet. Fixed is the whole point,
							// so nothing here has to track the spinner's size; h-8 is
							// where that size and the py-2 this row used to add left it.
							<div
								ref={sentinelRef}
								className="flex h-8 items-center justify-center"
							>
								{isLoadingMoreHistory && (
									<Spinner
										variant="current"
										className="text-th-text-muted"
										srText="Loading earlier messages"
									/>
								)}
							</div>
						)
					)}
					{forkBanner}
					{/* Only after the user has actually paged back — on a conversation
					    that never needed a second page, saying where it starts states
					    the obvious — and only where the fork banner is not already
					    saying the same thing in more detail. */}
					{!hasMoreHistory && loadedHistoryPages > 0 && !forkBanner && (
						<p className="py-2 text-center text-th-text-muted text-xs">
							Beginning of conversation
						</p>
					)}
					{messages.map((message, index) => {
						return (
							<div
								key={message.id}
								data-message-id={message.id}
								className="py-1.5 sm:py-2"
							>
								<MessageItem
									message={message}
									sessionId={sessionId}
									// Top of the loaded transcript is the session's own start
									// only once there are no older pages left above it.
									isFirst={index === 0 && !hasMoreHistory}
									isOpenTurn={index === openIndex}
									isCodex={isCodex}
									onPermissionRespond={onPermissionRespond}
									onAnswerQuestion={onAnswerQuestion}
									promptError={promptError}
									onOpenWorkDetail={onOpenWorkDetail}
									onOpenFile={onOpenFile}
									onForkMessage={onForkMessage}
								/>
							</div>
						);
					})}
				</div>
			</div>

			{showScrollButton && (
				<button
					type="button"
					onClick={handleScrollToBottom}
					className="absolute bottom-4 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-th-border bg-th-bg-primary text-th-text-secondary pointer-coarse:size-11 shadow-xl transition-colors hover:bg-th-bg-secondary hover:text-th-text-primary"
					aria-label="Scroll to bottom"
				>
					<ArrowDown className="h-5 w-5" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

export default MessageList;
