import { type KeyboardEvent, useCallback, useState } from "react";

interface Props {
	onSend: (content: string) => void;
	disabled?: boolean;
	isStreaming?: boolean;
	onInterrupt?: () => void;
}

function InputBar({
	onSend,
	disabled = false,
	isStreaming = false,
	onInterrupt,
}: Props) {
	const [input, setInput] = useState("");

	const handleSend = useCallback(() => {
		const trimmed = input.trim();
		if (trimmed && !disabled && !isStreaming) {
			onSend(trimmed);
			setInput("");
		}
	}, [input, onSend, disabled, isStreaming]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	return (
		<div className="border-t border-gray-700 p-4">
			<div className="flex gap-2">
				<textarea
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Type a message..."
					disabled={disabled}
					rows={1}
					className="flex-1 resize-none rounded-lg bg-gray-800 px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
				/>
				{isStreaming ? (
					<button
						type="button"
						onClick={onInterrupt}
						className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700"
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						onClick={handleSend}
						disabled={disabled || !input.trim()}
						className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}

export default InputBar;
