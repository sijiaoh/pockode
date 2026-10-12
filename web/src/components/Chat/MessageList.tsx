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
import type { TurnTail } from "../../lib/thinking";
import type {
	Message,
	PermissionRequest,
	UserMessage,
} from "../../types/message";
import type { AgentType } from "../../types/settings";
import { TRANSCRIPT_HEIGHT_VAR } from "../ui";
import {
	DiscardedMessagesContext,
	useDiscardedMessagesValue,
} from "./discardedMessagesContext";
import ForkOriginBanner from "./ForkOriginBanner";
import HistoryReserve from "./HistoryReserve";
import MessageItem, {
	type PermissionChoice,
	type PromptError,
} from "./MessageItem";
import { anchorCandidateProps } from "./scrollAnchor";
import { TranscriptViewContext } from "./transcriptViewContext";
import {
	IDLE_TAIL,
	OpenedThoughtsContext,
	TurnTailContext,
} from "./turnTailContext";
import {
	UnfiledChildrenContext,
	useUnfiledChildrenValue,
} from "./unfiledChildrenContext";
import { useTranscriptScroll } from "./useTranscriptScroll";

const HIGHLIGHT_DURATION_MS = 1500;
const HIGHLIGHT_CLASS = "jump-highlight";

/**
 * How far above the view, in views, the top of the loaded history may be before
 * an older page is asked for. One: a page asked for then has a screen of reading
 * to arrive in before the reader is shown the skeleton in its place.
 */
const PAGE_AHEAD_VIEWS = 1;

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
	/** Must be stable: it reaches the memoized `MessageItem`. */
	onSignIn?: (agent: AgentType, messageId: string) => void;
	/** Must be stable: it reaches the memoized `MessageItem`. */
	onRestoreMessages?: (messages: UserMessage[]) => void;
	/**
	 * The transcript belongs to another worktree and can only be read. Only the
	 * empty state needs telling: everything else here already goes quiet when
	 * the handler it would call is withheld.
	 */
	isReadOnly?: boolean;
	/** What the reply being written ends on; see `TurnTail`. */
	tail?: TurnTail;
	/** See `useChatMessages`. */
	openedThoughtIds?: ReadonlySet<string>;
}

const NO_OPENED_THOUGHTS: ReadonlySet<string> = new Set();

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
	onSignIn,
	onRestoreMessages,
	isReadOnly = false,
	tail,
	openedThoughtIds = NO_OPENED_THOUGHTS,
}: Props) {
	const { EmptyState: CustomEmptyState } = useChatUIConfig();
	const scrollRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const reserveRef = useRef<HTMLDivElement>(null);
	// Everything about where the view sits lives in there: two states, one
	// action. Called first so that the invariant for this commit is applied before
	// anything below reads a position back out of the container.
	const { showScrollButton, hasUnseen, scrollToBottom, jumpTo, view } =
		useTranscriptScroll({
			scrollRef,
			trackRef,
			contentRef,
			messages,
			loadedHistoryPages,
			hasMoreHistory,
		});

	// The view's height, for the blocks inside it whose budget is a share of it
	// (`ClampedContent`) — a share of the window would be most of a transcript
	// squeezed under the software keyboard, or between a header and an input.
	const hasContainer = messages.length > 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasContainer triggers re-observe when the scroll container mounts
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const publish = () =>
			el.style.setProperty(TRANSCRIPT_HEIGHT_VAR, `${el.clientHeight}px`);
		// At once as well as on resize: the first observation arrives after the
		// sections have already measured themselves against the fallback.
		publish();
		const observer = new ResizeObserver(publish);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasContainer]);

	// Mirrors the prop rather than closing over it: `requestOlderPage` must keep
	// its identity, or the reserve's observer below would re-observe every time a
	// page starts or finishes loading — and a fresh observer reports a reserve
	// that is still in range straight away.
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

	// The top of the loaded history coming within `PAGE_AHEAD_VIEWS` of the view
	// is what asks for a page — ahead of the reader, so that on a steady read up
	// the next page is usually in before they get there. Landing mid-flick costs
	// nothing: the page goes into the reserve and nothing is written
	// (`useTranscriptScroll`).
	//
	// Watched through the reserve, whose bottom edge is the rows' top wherever
	// the track puts them, with the observer's root stretched upwards by that
	// much: the browser then reports the crossing off the scroll itself, with no
	// work of ours on every frame of a flick. The reserve's own top can never be
	// below the view's bottom edge, so its bottom edge is the whole of the
	// question.
	//
	// One observer for as long as the reserve is mounted — except while a failure
	// stands, when there is nothing to ask until Retry — never rebuilt per page:
	// rebuilding it is what produced the paging loop, because a new observer
	// reports a target already in range immediately and a page that moved nothing
	// leaves it exactly there.
	//
	// The report is acted on as given, and it is the only thing that can say the
	// reader has read up towards the top: scrolling commits nothing, so there is
	// no frame in which the list could have measured that for itself. Nor is it
	// the remembered visibility the effect below deliberately does without — a
	// delivered entry was computed at the most recent layout, which is one this
	// commit's own writes have already gone into.
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasContainer triggers re-observe when the scroll container mounts
	useEffect(() => {
		const reserve = reserveRef.current;
		const scrollEl = scrollRef.current;
		if (!reserve || !scrollEl || !hasMoreHistory || historyError) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[entries.length - 1].isIntersecting) requestOlderPage();
			},
			{
				root: scrollEl,
				rootMargin: `${PAGE_AHEAD_VIEWS * 100}% 0px 0px 0px`,
				threshold: 0,
			},
		);
		observer.observe(reserve);
		return () => observer.disconnect();
	}, [hasContainer, hasMoreHistory, historyError, requestOlderPage]);

	// The other half of the paging trigger, and the reason paging keeps going
	// until the reader is a view ahead again: an observer reports a *crossing*,
	// so a page that lands without taking the rows' top out of range is never
	// reported again — and a page landing goes into the reserve and moves nothing
	// the reader can see. A short page, or a view taller than a page, is exactly
	// that. So the rows' top is measured here as well, on every commit, after the
	// invariant above has placed the view.
	//
	// A state ("the top of history is within reach") rather than an event ("a
	// page landed"): asking is idempotent — a request in flight is refused, and
	// each one that does go out moves the cursor further back, so this settles at
	// the rows' top out of range or `hasMoreHistory` being false. Keyed on a page
	// landing instead, the whole continuation would hang on the loading flag and
	// the page count reaching this in the same commit.
	useLayoutEffect(() => {
		if (!hasMoreHistory || historyError) return;
		const rows = contentRef.current;
		const scrollEl = scrollRef.current;
		if (!rows || !scrollEl) return;

		// A container with no height shows nothing, so nothing is in view — it has
		// not been laid out yet, and answering "is the top of history near?" from
		// that would ask for history nobody has come near.
		if (scrollEl.clientHeight === 0) return;
		const viewTop = scrollEl.getBoundingClientRect().top + scrollEl.clientTop;
		const ahead = PAGE_AHEAD_VIEWS * scrollEl.clientHeight;
		if (rows.getBoundingClientRect().top >= viewTop - ahead) {
			requestOlderPage();
		}
	});

	// Which bubble the open turn is writing into, so a reply can say it is still
	// being written wherever it sits. Position stopped answering that when a
	// message sent mid-reply began landing *below* the reply it went into
	// (docs/lifecycle-ui.md §2.3): the last row is then the message, not the turn.
	const openIndex = openAssistantIndex(messages);
	const unfiled = useUnfiledChildrenValue(messages);
	const discardedContext = useDiscardedMessagesValue(messages, hasMoreHistory);

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
			// is one a keyboard user cannot perceive — and a focus into an `inert`
			// subtree is dropped without a word, so a caller jumping out from under
			// something that covers the transcript has to let the cover go first
			// (`ChatPanel.handleJumpToRequest`).
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
			    under the invariant, and Safari before 27 does not implement it at
			    all, so the two would not even disagree the same way on each
			    platform. */}
			<div
				ref={scrollRef}
				className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain [overflow-anchor:none]"
			>
				{/* The track: its height is `useTranscriptScroll`'s to write, and the
				    rows sit on its bottom edge, so growth above the reader goes up
				    into the reserve without moving them. `min-h-full` only until the
				    first write, which never goes below it either.

				    The reading width is on the track, not the scroller: the scrollbar
				    stays at the pane's edge and the wheel works over the margins. */}
				<div
					ref={trackRef}
					className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end px-3 sm:px-4"
				>
					{hasMoreHistory && (
						<HistoryReserve
							ref={reserveRef}
							error={historyError}
							onRetry={requestOlderPage}
						/>
					)}
					{/* `shrink-0`: the rows keep their height when the track is shorter
					    than they are, and go past its top instead, which is out of reach
					    until the view is at rest and the track is put right. */}
					<div ref={contentRef} className="flex shrink-0 flex-col">
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
						<TurnTailContext value={tail ?? IDLE_TAIL}>
							<OpenedThoughtsContext value={openedThoughtIds}>
								<UnfiledChildrenContext value={unfiled}>
									<DiscardedMessagesContext value={discardedContext}>
										<TranscriptViewContext value={view}>
											{messages.map((message, index) => {
												return (
													<div
														key={message.id}
														data-message-id={message.id}
														// This wrapper is the row the view can be held still over
														// (see `scrollAnchor`).
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
															onSignIn={onSignIn}
															isDiscarded={
																message.role === "user" &&
																message.messageId !== undefined &&
																discardedContext.discarded.has(
																	message.messageId,
																)
															}
															onRestoreMessages={onRestoreMessages}
														/>
													</div>
												);
											})}
										</TranscriptViewContext>
									</DiscardedMessagesContext>
								</UnfiledChildrenContext>
							</OpenedThoughtsContext>
						</TurnTailContext>
					</div>
					{/* Sticky inside the column rather than absolute over the pane, so
					    it centres on the column by construction — the pane also holds
					    the scrollbar, which the column is centred without. Zero height,
					    so it adds nothing to the content the resize observer measures.

					    Centred rather than in the corner: the right-hand column is where
					    a row keeps the facts it is read for — counts, elapsed, copy,
					    Open — and there the button covered the only number on the line,
					    while in the middle it covers prose that reads around it. */}
					{showScrollButton && (
						// `z-3`: over an open row's bar (`row-bar`, z-index 2, or 3
						// while focused — this comes later, so it still wins), which
						// passes under the button whenever an open row's first line is
						// at the bottom of the view.
						<div className="pointer-events-none sticky bottom-3 z-3 h-0">
							<div className="absolute inset-x-0 bottom-0 flex justify-center">
								<button
									type="button"
									onClick={scrollToBottom}
									className="touch-target pointer-events-auto flex h-8 w-11 items-center justify-center rounded-full border border-th-border bg-th-bg-primary text-th-text-secondary shadow-lg transition-colors hover:bg-th-bg-secondary hover:text-th-text-primary"
									aria-label={
										hasUnseen
											? "Scroll to bottom, new messages"
											: "Scroll to bottom"
									}
								>
									<ArrowDown className="size-4" aria-hidden="true" />
									{hasUnseen && (
										<span
											data-testid="unseen-dot"
											className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-th-accent ring-2 ring-th-bg-primary"
											aria-hidden="true"
										/>
									)}
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export default MessageList;
