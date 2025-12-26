import { useEffect, useRef } from "react";
import type { Message } from "../../types/message";
import MessageItem from "./MessageItem";

interface Props {
	messages: Message[];
}

function MessageList({ messages }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const userScrolledUp = useRef(false);

	// Detect user scroll: if scrolling away from bottom, mark as scrolled up
	const handleScroll = () => {
		const container = containerRef.current;
		if (!container) return;

		const threshold = 50;
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;

		userScrolledUp.current = distanceFromBottom > threshold;
	};

	// Auto scroll to bottom only if user hasn't scrolled up
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages triggers scroll on any update
	useEffect(() => {
		const container = containerRef.current;
		if (!userScrolledUp.current && container) {
			container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
		}
	}, [messages]);

	return (
		<div
			ref={containerRef}
			onScroll={handleScroll}
			className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:space-y-4 sm:p-4"
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
	);
}

export default MessageList;
