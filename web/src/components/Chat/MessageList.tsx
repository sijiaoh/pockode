import { ArrowDown } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import type {
	AskUserQuestionRequest,
	Message,
	PermissionRequest,
} from "../../types/message";
import MessageItem, { type PermissionChoice } from "./MessageItem";

const PAGE_SIZE = 50;
const AT_BOTTOM_THRESHOLD = 50;

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
}

function MessageList({
	messages,
	isProcessRunning,
	isCodex,
	onPermissionRespond,
	onQuestionRespond,
	onHintClick,
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
