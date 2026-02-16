import { Send } from "lucide-react";
import { useState } from "react";
import type { InputBarProps } from "../../../lib/registries/chatUIRegistry";

export default function CustomInputBar({
	onSend,
	canSend = true,
	isStreaming,
	onStop,
}: InputBarProps) {
	const [input, setInput] = useState("");

	const handleSend = () => {
		if (input.trim() && canSend) {
			onSend(input.trim());
			setInput("");
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	return (
		<div className="flex items-center gap-2 border-t border-th-border bg-th-bg-secondary p-3">
			<input
				type="text"
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Type a message..."
				disabled={!canSend}
				className="flex-1 rounded-full border border-th-border bg-th-bg-primary px-4 py-2 text-sm th-text-primary placeholder:th-text-muted focus:outline-none focus:ring-2 focus:ring-th-accent"
			/>
			{isStreaming && onStop ? (
				<button
					type="button"
					onClick={onStop}
					className="rounded-full bg-th-error px-4 py-2 text-sm text-th-text-inverse"
				>
					Stop
				</button>
			) : (
				<button
					type="button"
					onClick={handleSend}
					disabled={!canSend || !input.trim()}
					className="rounded-full bg-th-accent p-2 text-th-text-inverse disabled:opacity-50"
				>
					<Send className="size-5" />
				</button>
			)}
		</div>
	);
}
