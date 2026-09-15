import { ArrowDown } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import type {
	AskUserQuestionRequest,
	Message,
	PermissionRequest,
} from "../../types/message";
import { findPendingQuestions } from "../../utils/pendingQuestions";
import { Spinner } from "../ui";
import ForkOriginBanner from "./ForkOriginBanner";
import MessageItem, { type PermissionChoice } from "./MessageItem";
import PendingQuestionPill from "./PendingQuestionPill";

const AT_BOTTOM_THRESHOLD = 50;
/**
 * A question header row is only "seen" when it is fully in view: a sliver of a
 * card peeking in at the edge tells the user nothing. Just under 1 to absorb
 * sub-pixel rounding.
 */
const QUESTION_VISIBLE_RATIO = 0.99;
/** Streaming output reflows constantly; showing instantly would flicker. */
const PILL_SHOW_DELAY_MS = 250;
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
const HIGHLIGHT_CLASS = "question-highlight";

interface QuestionVisibility {
	visible: boolean;
	direction: "up" | "down";
}

// Attribute lookup rather than a `[data-...="id"]` selector so request ids never
// need CSS escaping.
function findQuestionCard(
	root: HTMLElement,
	requestId: string,
): HTMLElement | null {
	for (const card of root.querySelectorAll<HTMLElement>(
		"[data-question-request-id]",
	)) {
		if (card.dataset.questionRequestId === requestId) return card;
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
	/** The container's height when the page was asked for; see the restore. */
	scrollHeight: number;
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
 * changes there is which message is first — and the anchor was pinned to the one
 * that was, which an empty page leaves in place.
 */
function madeProgress(el: HTMLElement, anchor: ScrollAnchor): boolean {
	if (el.scrollHeight > el.clientHeight) return el.scrollTop > anchor.scrollTop;
	const first = el.querySelector<HTMLElement>("[data-message-id]");
	return !!first && first.dataset.messageId !== anchor.messageId;
}

function isAtBottom(el: HTMLElement): boolean {
	return (
		el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD
	);
}

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Props {
	messages: Message[];
	isProcessRunning: boolean;
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
	onQuestionRespond?: (
		request: AskUserQuestionRequest,
		answers: Record<string, string> | null,
	) => void;
	onHintClick?: (hint: string) => void;
	onOpenWorkDetail?: (workId: string) => void;
	/** The session this one was forked from, if it was. */
	forkedFromSessionId?: string;
	onOpenSession?: (sessionId: string) => void;
	/** Must be stable: it reaches the memoized `MessageItem`. */
	onForkMessage?: (messageId: string) => void;
}

function MessageList({
	messages,
	isProcessRunning,
	hasMoreHistory = false,
	isLoadingMoreHistory = false,
	historyError = null,
	loadedHistoryPages = 0,
	onLoadMoreHistory,
	isCodex,
	onPermissionRespond,
	onQuestionRespond,
	onHintClick,
	onOpenWorkDetail,
	forkedFromSessionId,
	onOpenSession,
	onForkMessage,
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
	// Where the view sat when an older page was asked for, pinned to the message
	// that was then at the top. A height difference would not do: the agent can
	// go on writing at the bottom while the page is in flight, and that growth is
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

	// Every request that actually starts re-pins the anchor, so a page that failed
	// cannot leave a stale one behind for the retry to restore to. A request that
	// the hook drops because a page is already in flight must not re-pin: the page
	// on its way will be restored against the view as it was when it was asked
	// for, not as it is now.
	const requestOlderPage = useCallback(() => {
		const scrollEl = scrollRef.current;
		const first =
			contentRef.current?.querySelector<HTMLElement>("[data-message-id]");
		if (!isLoadingMoreRef.current && scrollEl && first?.dataset.messageId) {
			scrollAnchorRef.current = {
				messageId: first.dataset.messageId,
				offsetTop: first.offsetTop,
				scrollTop: scrollEl.scrollTop,
				scrollHeight: scrollEl.scrollHeight,
			};
		}
		onLoadMoreHistory?.();
	}, [onLoadMoreHistory]);

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
				if (entries[0].isIntersecting) requestOlderPage();
			},
			{ root: scrollEl, threshold: 0 },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMoreHistory, historyError, sentinelArmKey, requestOlderPage]);

	// Hold the view still over the messages that were already on screen after an
	// older page is spliced in above them.
	const prevTotalCountRef = useRef(totalCount);
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedHistoryPages is the trigger — it marks the commit that prepended a page
	useLayoutEffect(() => {
		const anchor = scrollAnchorRef.current;
		const el = scrollRef.current;
		scrollAnchorRef.current = null;
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
		// next, even if they had scrolled away. System-driven rows are nobody's
		// gesture and say nothing about intent.
		const last = messages[totalCount - 1];
		if (last.role === "user" && last.source !== "system") {
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

	const pendingQuestions = useMemo(
		() => findPendingQuestions(messages),
		[messages],
	);
	// Identity of the pending set, so effects re-run when a question is added or
	// answered but not on every streamed token.
	const pendingKey = pendingQuestions.map((q) => q.requestId).join("\u0000");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by pendingKey so the set stays identical while the ids do
	const pendingIds = useMemo(
		() => new Set(pendingQuestions.map((q) => q.requestId)),
		[pendingKey],
	);

	const [questionVisibility, setQuestionVisibility] = useState<
		Record<string, QuestionVisibility>
	>({});

	// Questions with no entry are unobservable — not rendered yet — and count as
	// hidden, which is exactly the case this pill exists for.
	const hiddenPending = pendingQuestions.filter(
		({ requestId }) => !questionVisibility[requestId]?.visible,
	);
	const hiddenCount = hiddenPending.length;
	const target = hiddenPending[0];
	// A question that is not rendered is always earlier than the viewport.
	const direction = target
		? (questionVisibility[target.requestId]?.direction ?? "up")
		: "up";

	// Observe the collapsed header row of every pending card: an expanded card can
	// be taller than the viewport and would never reach the full-visibility
	// threshold, while the header row is both short and the card's entry point.
	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedHistoryPages/hasMessages are triggers — they change which question nodes exist
	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl) return;

		const headers = new Map<string, Element>();
		for (const card of scrollEl.querySelectorAll<HTMLElement>(
			"[data-question-request-id]",
		)) {
			const requestId = card.dataset.questionRequestId;
			if (!requestId || !pendingIds.has(requestId)) continue;
			const header = card.querySelector("[data-question-header]");
			if (header) headers.set(requestId, header);
		}

		// Rebuild the map around the cards that actually exist: drop questions whose
		// node is gone (answered) so a stale "visible" can never suppress the pill,
		// and seed the ones that have just appeared.
		setQuestionVisibility((prev) => {
			let changed = Object.keys(prev).length !== headers.size;
			const next: Record<string, QuestionVisibility> = {};
			for (const requestId of headers.keys()) {
				const known = prev[requestId];
				if (known) {
					next[requestId] = known;
					continue;
				}
				// A rendered card counts as on screen until the observer says
				// otherwise, because starting from hidden would flash the pill over a
				// question already in front of the user whenever the first callback
				// lands after the show debounce. Guessing this way round only ever
				// costs one callback of delay, and a question with no node at all
				// still gets no entry, so "not rendered means hidden" is untouched.
				next[requestId] = { visible: true, direction: "up" };
				changed = true;
			}
			// This effect re-runs on every appended message; keeping prev when nothing
			// moved avoids a needless re-render.
			return changed ? next : prev;
		});

		if (headers.size === 0) return;

		const observer = new IntersectionObserver(
			(entries) => {
				setQuestionVisibility((prev) => {
					const next = { ...prev };
					for (const entry of entries) {
						const card = entry.target.closest<HTMLElement>(
							"[data-question-request-id]",
						);
						const requestId = card?.dataset.questionRequestId;
						if (!requestId) continue;
						next[requestId] = {
							visible: entry.intersectionRatio >= QUESTION_VISIBLE_RATIO,
							direction:
								entry.rootBounds &&
								entry.boundingClientRect.top >= entry.rootBounds.top
									? "down"
									: "up",
						};
					}
					return next;
				});
			},
			{ root: scrollEl, threshold: [0, QUESTION_VISIBLE_RATIO] },
		);

		for (const header of headers.values()) observer.observe(header);
		return () => observer.disconnect();
	}, [hasMessages, pendingIds, loadedHistoryPages]);

	const [showPill, setShowPill] = useState(false);
	useEffect(() => {
		if (hiddenCount === 0) {
			setShowPill(false);
			return;
		}
		const timer = setTimeout(() => setShowPill(true), PILL_SHOW_DELAY_MS);
		return () => clearTimeout(timer);
	}, [hiddenCount]);

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

	const scrollToQuestion = useCallback(
		(requestId: string) => {
			const scrollEl = scrollRef.current;
			if (!scrollEl) return;
			const card = findQuestionCard(scrollEl, requestId);
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
			card
				.querySelector<HTMLElement>("[data-question-header]")
				?.focus({ preventScroll: true });
		},
		[clearHighlight, abandonRestoreWindow],
	);

	// Every loaded message is rendered, and a question the server has not sent yet
	// is not among `pendingQuestions` at all, so the target always has a node.
	const handlePillClick = useCallback(() => {
		if (target) scrollToQuestion(target.requestId);
	}, [target, scrollToQuestion]);

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
							<div
								ref={sentinelRef}
								className="flex items-center justify-center py-2"
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
						const isLast = index === totalCount - 1;
						return (
							<div
								key={message.id}
								data-message-id={message.id}
								className="py-1.5 sm:py-2"
							>
								<MessageItem
									message={message}
									// Top of the loaded transcript is the session's own start
									// only once there are no older pages left above it.
									isFirst={index === 0 && !hasMoreHistory}
									isLast={isLast}
									isProcessRunning={isLast && isProcessRunning}
									isCodex={isCodex}
									onPermissionRespond={onPermissionRespond}
									onQuestionRespond={onQuestionRespond}
									onOpenWorkDetail={onOpenWorkDetail}
									onForkMessage={onForkMessage}
								/>
							</div>
						);
					})}
				</div>
			</div>

			{/* <output> is an implicit live region, and it stays mounted at all
			    times: a live region that appears together with its content is not
			    announced by most screen readers. */}
			<output className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 sm:top-3">
				{showPill && target && (
					<PendingQuestionPill
						count={hiddenCount}
						direction={direction}
						onClick={handlePillClick}
					/>
				)}
			</output>

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
