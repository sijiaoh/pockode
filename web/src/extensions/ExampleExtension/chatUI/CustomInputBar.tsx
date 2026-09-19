import { Send } from "lucide-react";
import { useState } from "react";
import type { InputBarProps } from "../../../lib/registries/chatUIRegistry";

/**
 * Send is permanent — including while a turn is running, which the agent accepts
 * as steering for the reply it is writing. Stop is not here: the host's action
 * bar above owns it, so a destructive 44px target never sits next to Send under
 * a thumb (docs/responsive-ui.md). `turnOpen` and `onStop` are still offered, for
 * an extension that draws its own action bar instead.
 */
export default function CustomInputBar({
	onSend,
	canSend = true,
	disabled = false,
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
			{/* `disabled`, not `canSend`: typing is never blocked, so a draft written
			    while the connection is down survives it. `canSend` gates the send. */}
			<input
				type="text"
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Type a message..."
				disabled={disabled}
				className="flex-1 rounded-full border border-th-border bg-th-bg-primary px-4 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:ring-2 focus:ring-th-accent"
			/>
			<button
				type="button"
				onClick={handleSend}
				disabled={disabled || !canSend || !input.trim()}
				className="flex size-9 items-center justify-center rounded-full bg-th-accent text-th-text-inverse disabled:opacity-50 pointer-coarse:size-11"
			>
				<Send className="size-5" />
			</button>
		</div>
	);
}
