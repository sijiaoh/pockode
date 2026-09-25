import { ArrowDown } from "lucide-react";
import {
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";
import { openAssistantIndex } from "../../lib/messageReducer";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import type { Message, PermissionRequest } from "../../types/message";
import { Spinner } from "../ui";
import ForkOriginBanner from "./ForkOriginBanner";
import MessageItem, {
	type PermissionChoice,
	type PromptError,
} from "./MessageItem";
import { anchorCandidateProps } from "./scrollAnchor";
import { useTranscriptScroll } from "./useTranscriptScroll";

const HIGHLIGHT_DURATION_MS = 1500;
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
	// Everything about where the view sits lives in there: two states, one
	// action. Called first so that the invariant for this commit is applied before
	// anything below reads a position back out of the container.
	const { showScrollButton, scrollToBottom, jumpTo } = useTranscriptScroll({
		scrollRef,
		contentRef,
		messages,
		loadedHistoryPages,
	});

	// Mirrors the prop rather than closing over it: `requestOlderPage` must keep
	// its identity, or the sentinel effect below would re-observe every time a page
	// starts or finishes loading — and a fresh observer reports a sentinel that is
	// still on screen straight away.
	const isLoadingMoreRef = useRef(isLoadingMoreHistory);
	useLayoutEffect(() => {
		isLoadingMoreRef.current = isLoadingMoreHistory;
	}, [isLoadingMoreHistory]);

	// A page in flight is the only thing a request is refused for. Nothing judges
	// how much the last page added: every request moves the cursor further back
	// and history is finite, so the most an unhelpful page can cost is one more
	// request.
	const requestOlderPage = useCallback(() => {
		if (isLoadingMoreRef.current) return;
		onLoadMoreHistory?.();
	}, [onLoadMoreHistory]);

	// One observer for as long as the sentinel is mounted, never rebuilt per page:
	// rebuilding it is what produced the paging loop, because a new observer
	// reports a target already on screen immediately and a page that moved nothing
	// leaves it exactly there.
	//
	// The report is acted on as given, and it is the only thing that can say the
	// reader has read back up to the top: scrolling commits nothing, so there is no
	// frame in which the list could have measured that for itself. Nor is it the
	// remembered visibility the effect below deliberately does without — a
	// delivered entry was computed at the most recent layout, which is one this
	// commit's own scroll write has already gone into.
	useEffect(() => {
		const sentinel = sentinelRef.current;
		const scrollEl = scrollRef.current;
		if (!sentinel || !scrollEl || !hasMoreHistory || historyError) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[entries.length - 1].isIntersecting) requestOlderPage();
			},
			{ root: scrollEl, threshold: 0 },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMoreHistory, historyError, requestOlderPage]);

	// The other half of the paging trigger, and the reason a short conversation
	// fills up: an observer reports a *crossing*, so a page that lands without
	// pushing the sentinel out of the view is never reported again — and a
	// transcript too short to fill the viewport moves nothing when a page lands
	// above it. So the sentinel is measured here as well, on every commit, after
	// the invariant above has placed the view.
	//
	// A state ("the top of history is on screen") rather than an event ("a page
	// landed"): asking is idempotent — a request in flight is refused, and each one
	// that does go out moves the cursor further back, so this settles at
	// `hasMoreHistory` being false. Keyed on a page landing instead, the whole
	// continuation would hang on the loading flag and the page count reaching this
	// in the same commit.
	useLayoutEffect(() => {
		if (!hasMoreHistory || historyError) return;
		const sentinel = sentinelRef.current;
		const scrollEl = scrollRef.current;
		if (!sentinel || !scrollEl) return;

		// A container with no height shows nothing, so nothing is in view — it has
		// not been laid out yet, and answering "is the top of history on screen?"
		// from that would ask for history nobody has come near.
		if (scrollEl.clientHeight === 0) return;
		const viewTop = scrollEl.scrollTop;
		const inView =
			sentinel.offsetTop <= viewTop + scrollEl.clientHeight &&
			sentinel.offsetTop + sentinel.offsetHeight >= viewTop;
		if (inView) requestOlderPage();
	});

	// Which bubble the open turn is writing into, so a reply can say it is still
	// being written wherever it sits. Position stopped answering that when a
	// message sent mid-reply began landing *below* the reply it went into
	// (docs/lifecycle-ui.md §2.3): the last row is then the message, not the turn.
	const openIndex = openAssistantIndex(messages);

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

			// The jump is where the view is meant to be now, so the card becomes the
			// anchor: the output that goes on landing below it must not push it away
			// again, which is the same promise reading anywhere else gets.
			jumpTo(card);

			clearHighlight();
			card.classList.add(HIGHLIGHT_CLASS);
			highlightRef.current = {
				card,
				timer: setTimeout(() => {
					card.classList.remove(HIGHLIGHT_CLASS);
					highlightRef.current = null;
				}, HIGHLIGHT_DURATION_MS),
			};

			// preventScroll: the browser's own focus scroll would move the view off
			// the position the jump just took the anchor at.
			//
			// The card's first button is the row that opens it, which is as close as
			// a permission card has to a header. Without moving the focus, the jump
			// is one a keyboard user cannot perceive.
			card.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
		},
		[clearHighlight, jumpTo],
	);

	useImperativeHandle(ref, () => ({ jumpToRequest: scrollToRequest }), [
		scrollToRequest,
	]);

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
			    by hand (see `useTranscriptScroll`): left on, it rewrites scrollTop
			    under the invariant, and Safari does not implement it at all, so the
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
							// the spinner appears moves them. The anchor would hold them
							// still through it, but holding still is a write to
							// `scrollTop`, and what brought the sentinel into view was a
							// flick whose momentum that write would cancel. Fixed is the
							// whole point, so nothing here has to track the spinner's
							// size; h-8 is where that size and the py-2 this row used to
							// add left it.
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
								// This wrapper is the row the view can be held still over, and
								// it is here rather than on anything `MessageItem` renders
								// because it is unpositioned (see `scrollAnchor`).
								{...anchorCandidateProps}
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
					onClick={scrollToBottom}
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
