import type { Message } from "../../types/message";
import { Spinner } from "../ui";

interface Props {
	message: Message;
}

function MessageItem({ message }: Props) {
	const isUser = message.role === "user";

	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[80%] rounded-lg p-3 ${
					isUser ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-100"
				}`}
			>
				{/* Message content */}
				<p className="whitespace-pre-wrap break-words">{message.content}</p>

				{/* Tool calls display */}
				{message.toolCalls && message.toolCalls.length > 0 && (
					<div className="mt-2 space-y-2">
						{message.toolCalls.map((tool, index) => (
							<div
								key={`${tool.name}-${index}`}
								className="rounded bg-gray-800 p-2 text-xs"
							>
								<span className="text-blue-400">{tool.name}</span>
								{tool.result && (
									<pre className="mt-1 overflow-x-auto text-gray-400">
										{tool.result}
									</pre>
								)}
							</div>
						))}
					</div>
				)}

				{/* Status indicator */}
				{message.status === "sending" && <Spinner className="mt-2" />}
				{message.status === "streaming" && (
					<span className="ml-1 inline-block h-4 w-2 animate-pulse bg-gray-400" />
				)}
				{message.status === "error" && (
					<p className="mt-2 text-sm text-red-400">{message.error}</p>
				)}
			</div>
		</div>
	);
}

export default MessageItem;
