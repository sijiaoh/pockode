import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import type {
	AskUserQuestionRequest,
	Message,
	PermissionRequest,
} from "../../types/message";
import MessageItem, { type PermissionChoice } from "./MessageItem";

interface Props {
	messages: Message[];
	sessionId: string;
	isProcessRunning: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	onQuestionRespond?: (
		request: AskUserQuestionRequest,
		answers: Record<string, string> | null,
	) => void;
}

function MessageList({
	messages,
	sessionId,
	isProcessRunning,
	onPermissionRespond,
	onQuestionRespond,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [isScrolledUp, setIsScrolledUp] = useState(false);
	const prevScrollHeightRef = useRef(0);

	// When switching sessions, reset scroll state so the messages effect will auto-scroll to bottom.
	// Without this, if user scrolled up in Session A (isScrolledUp=true) and switches to Session B,
	// the state persists and prevents auto-scrolling to the latest messages.
	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers reset on session switch
	useEffect(() => {
		setIsScrolledUp(false);
	}, [sessionId]);

	// Detect user scroll: if scrolling away from bottom, mark as scrolled up
	const handleScroll = () => {
		const container = containerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const threshold = 50;
		const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

		// When content height changes (e.g., markdown renders, code expands),
		// avoid incorrectly marking as "scrolled up" due to height growth.
		// But if we're at the bottom, ensure isScrolledUp stays false.
		if (scrollHeight !== prevScrollHeightRef.current) {
			prevScrollHeightRef.current = scrollHeight;
			if (distanceFromBottom <= threshold) {
				setIsScrolledUp(false);
			}
			return;
		}

		setIsScrolledUp(distanceFromBottom > threshold);
	};

	const scrollToBottom = useCallback(() => {
		const container = containerRef.current;
		if (container) {
			container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
		}
	}, []);

	// Auto scroll to bottom only if user hasn't scrolled up
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll on any update
	useEffect(() => {
		if (!isScrolledUp) {
			scrollToBottom();
		}
	}, [messages]);

	// Keep scrolled to bottom when content height grows (e.g., code block rendering)
	useStickToBottom(containerRef, messages.length > 0 && !isScrolledUp);

	return (
		<div className="relative min-h-0 flex-1">
			{messages.length === 0 ? (
				<div className="flex h-full items-center justify-center text-th-text-muted">
					<p>Start a conversation...</p>
				</div>
			) : (
				<div
					ref={containerRef}
					onScroll={handleScroll}
					className="flex h-full flex-col overflow-y-auto p-3 sm:p-4"
				>
					<div className="flex-1" />
					<div className="space-y-3 sm:space-y-4">
						{messages.map((message, index) => (
							<MessageItem
								key={message.id}
								message={message}
								isLast={index === messages.length - 1}
								isProcessRunning={isProcessRunning}
								onPermissionRespond={onPermissionRespond}
								onQuestionRespond={onQuestionRespond}
							/>
						))}
					</div>
				</div>
			)}
			{isScrolledUp && (
				<button
					type="button"
					onClick={scrollToBottom}
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
