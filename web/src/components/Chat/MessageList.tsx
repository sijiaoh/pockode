import { useEffect, useRef, useState } from "react";
import type { Message } from "../../types/message";
import MessageItem from "./MessageItem";

interface Props {
	messages: Message[];
}

function MessageList({ messages }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [isScrolledUp, setIsScrolledUp] = useState(false);

	// Detect user scroll: if scrolling away from bottom, mark as scrolled up
	const handleScroll = () => {
		const container = containerRef.current;
		if (!container) return;

		const threshold = 50;
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;

		setIsScrolledUp(distanceFromBottom > threshold);
	};

	// Auto scroll to bottom only if user hasn't scrolled up
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll on any update
	useEffect(() => {
		const container = containerRef.current;
		if (!isScrolledUp && container) {
			container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
		}
	}, [messages]);

	const scrollToBottom = () => {
		const container = containerRef.current;
		if (container) {
			container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
		}
	};

	return (
		<div className="relative min-h-0 flex-1">
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="h-full space-y-3 overflow-y-auto p-3 sm:space-y-4 sm:p-4"
			>
				{messages.length === 0 && (
					<div className="flex h-full items-center justify-center text-gray-500">
						<p>Start a conversation...</p>
					</div>
				)}
				{messages.map((message) => (
					<MessageItem key={message.id} message={message} />
				))}
			</div>
			{isScrolledUp && (
				<button
					type="button"
					onClick={scrollToBottom}
					className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-gray-700 p-2 text-gray-300 shadow-lg transition-colors hover:bg-gray-600 hover:text-white"
					aria-label="Scroll to bottom"
				>
					<svg
						className="h-5 w-5"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M19 14l-7 7m0 0l-7-7m7 7V3"
						/>
					</svg>
				</button>
			)}
		</div>
	);
}

export default MessageList;
