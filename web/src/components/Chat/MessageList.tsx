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
import ForkOriginBanner from "./ForkOriginBanner";
import MessageItem, { type PermissionChoice } from "./MessageItem";
import PendingQuestionPill from "./PendingQuestionPill";

const PAGE_SIZE = 50;
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

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Props {
	messages: Message[];
	isProcessRunning: boolean;
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
	onOpenMessageMenu?: (messageId: string) => void;
}

function MessageList({
	messages,
	isProcessRunning,
	isCodex,
	onPermissionRespond,
	onQuestionRespond,
	onHintClick,
	onOpenWorkDetail,
	forkedFromSessionId,
	onOpenSession,
	onOpenMessageMenu,
}: Props) {
	const { EmptyState: CustomEmptyState } = useChatUIConfig();
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const [showScrollButton, setShowScrollButton] = useState(false);
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const isAtBottomRef = useRef(true);
	const isLoadingMoreRef = useRef(false);
	const scrollAnchorRef = useRef<{
		scrollHeight: number;
		scrollTop: number;
	} | null>(null);

	const totalCount = messages.length;
	const startIndex = Math.max(0, totalCount - visibleCount);
	const visibleMessages = messages.slice(startIndex);
	const hasMore = startIndex > 0;
	// Scroll container is only mounted when messages are non-empty (see early return below).
	// Effects that attach to the container must re-run on this transition.
	const hasMessages = totalCount > 0;

	// Track at-bottom state via scroll events
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasMessages triggers re-attach when scroll container mounts
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;

		const handleScroll = () => {
			const atBottom =
				el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
			isAtBottomRef.current = atBottom;
			setShowScrollButton(!atBottom);
		};

		el.addEventListener("scroll", handleScroll, { passive: true });
		return () => el.removeEventListener("scroll", handleScroll);
	}, [hasMessages]);

	// Re-create observer after each page load so it fires again if sentinel is still visible
	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount is an intentional trigger to re-observe after prepend
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const scrollEl = scrollRef.current;
		if (!sentinel || !scrollEl || !hasMore) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0].isIntersecting && !isLoadingMoreRef.current) {
					isLoadingMoreRef.current = true;
					scrollAnchorRef.current = {
						scrollHeight: scrollEl.scrollHeight,
						scrollTop: scrollEl.scrollTop,
					};
					setVisibleCount((c) => c + PAGE_SIZE);
				}
			},
			{ root: scrollEl, threshold: 0 },
		);

		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, visibleCount]);

	// Restore scroll position after prepending older messages
	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount is an intentional trigger — runs when a new page is prepended
	useLayoutEffect(() => {
		const anchor = scrollAnchorRef.current;
		const el = scrollRef.current;
		if (!anchor || !el) return;

		const heightDiff = el.scrollHeight - anchor.scrollHeight;
		el.scrollTop = anchor.scrollTop + heightDiff;
		scrollAnchorRef.current = null;
		isLoadingMoreRef.current = false;
	}, [visibleCount]);

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
	// isAtBottomRef may become stale by that time. useLayoutEffect fires
	// synchronously after DOM commit, so it captures isAtBottomRef before any
	// async events can modify it.
	const prevTotalCountRef = useRef(totalCount);
	useLayoutEffect(() => {
		const prev = prevTotalCountRef.current;
		prevTotalCountRef.current = totalCount;

		const el = scrollRef.current;
		if (el && totalCount > prev && isAtBottomRef.current) {
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
			if (isAtBottomRef.current) {
				scrollEl.scrollTop = scrollEl.scrollHeight;
			}
		});

		observer.observe(content);
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

	// Questions with no entry are unobservable — either not rendered yet or
	// outside the pagination window — and count as hidden, which is exactly the
	// case this pill exists for.
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount/startIndex/hasMessages are triggers — they change which question nodes exist
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
		// node is gone (answered, or outside the render window) so a stale "visible"
		// can never suppress the pill, and seed the ones that have just appeared.
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
			// This effect re-runs on every appended message once paginated; keeping
			// prev when nothing moved avoids a needless re-render.
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
	}, [hasMessages, pendingIds, visibleCount, startIndex]);

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

			// Jumping is a deliberate move away from the tail. Without dropping the
			// at-bottom flag first, the auto-follow would undo the jump: widening the
			// render window grows the content, and the ResizeObserver that reacts to
			// that still sees `isAtBottomRef` set (scroll events from the smooth
			// scroll have not been dispatched yet) and snaps back to the bottom.
			isAtBottomRef.current = false;
			setShowScrollButton(true);

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
		[clearHighlight],
	);

	// Set when the jump target lies outside the render window: the scroll has to
	// wait until the widened page has been committed to the DOM.
	const deferredScrollTargetRef = useRef<string | null>(null);

	const handlePillClick = useCallback(() => {
		if (!target) return;
		if (target.messageIndex < startIndex) {
			const needed = totalCount - target.messageIndex;
			deferredScrollTargetRef.current = target.requestId;
			setVisibleCount((c) =>
				Math.max(c, Math.ceil(needed / PAGE_SIZE) * PAGE_SIZE),
			);
			return;
		}
		scrollToQuestion(target.requestId);
	}, [target, startIndex, totalCount, scrollToQuestion]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount is the trigger — the target node only exists after the widened page is committed
	useLayoutEffect(() => {
		const requestId = deferredScrollTargetRef.current;
		if (!requestId) return;
		deferredScrollTargetRef.current = null;
		scrollToQuestion(requestId);
	}, [visibleCount, scrollToQuestion]);

	const handleScrollToBottom = useCallback(() => {
		scrollRef.current?.scrollTo({
			top: scrollRef.current.scrollHeight,
			behavior: "smooth",
		});
	}, []);

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
			<div
				ref={scrollRef}
				className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain"
			>
				<div
					ref={contentRef}
					className="flex min-h-full flex-col justify-end px-3 sm:px-4"
				>
					{/* Only with the top of the history actually on screen: pinned
					    above a window into the middle of a transcript, the banner would
					    claim a position it does not have. */}
					{startIndex === 0 && forkedFromSessionId && onOpenSession && (
						<ForkOriginBanner
							parentSessionId={forkedFromSessionId}
							onOpenParent={onOpenSession}
						/>
					)}
					{hasMore && <div ref={sentinelRef} className="h-1" />}
					{visibleMessages.map((message, index) => {
						const globalIndex = startIndex + index;
						const isLast = globalIndex === totalCount - 1;
						return (
							<div key={message.id} className="py-1.5 sm:py-2">
								<MessageItem
									message={message}
									isLast={isLast}
									isProcessRunning={isLast && isProcessRunning}
									isCodex={isCodex}
									onPermissionRespond={onPermissionRespond}
									onQuestionRespond={onQuestionRespond}
									onOpenWorkDetail={onOpenWorkDetail}
									onOpenMessageMenu={onOpenMessageMenu}
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
					className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-th-border bg-th-bg-primary p-2 text-th-text-secondary shadow-xl transition-colors hover:bg-th-bg-secondary hover:text-th-text-primary"
					aria-label="Scroll to bottom"
				>
					<ArrowDown className="h-5 w-5" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

export default MessageList;
