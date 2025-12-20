import { useEffect, useRef } from "react";
import type { Message } from "../../types/message";
import MessageItem from "./MessageItem";

interface Props {
	messages: Message[];
}

function MessageList({ messages }: Props) {
	const endRef = useRef<HTMLDivElement>(null);

	// Auto scroll to bottom when messages change
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages.length is intentional to trigger scroll on new messages
	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages.length]);

	return (
		<div className="flex-1 space-y-4 overflow-y-auto p-4">
			{messages.length === 0 && (
				<div className="flex h-full items-center justify-center text-gray-500">
					<p>Start a conversation...</p>
				</div>
			)}
			{messages.map((message) => (
				<MessageItem key={message.id} message={message} />
			))}
			<div ref={endRef} />
		</div>
	);
}

export default MessageList;
