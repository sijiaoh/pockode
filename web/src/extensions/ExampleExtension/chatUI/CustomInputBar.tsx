import { Send, Square } from "lucide-react";
import { useState } from "react";
import { Armed, slotShowsStop } from "../../../components/Chat/SendStopSlot";
import type { InputBarProps } from "../../../lib/registries/chatUIRegistry";

/**
 * Send and Stop share one slot, as in the default bar: the host draws no Stop
 * once a custom bar is installed, so drawing it is this bar's job. Never both
 * at once, so a destructive 44px target never sits next to Send under a thumb
 * (docs/lifecycle-ui.md §2.3); Send stays for a draft written mid-turn, which the
 * agent takes as steering for the reply it is writing.
 */
export default function CustomInputBar({
	onSend,
	canSend = true,
	disabled = false,
	turnOpen = false,
	onStop,
}: InputBarProps) {
	const [input, setInput] = useState("");
	const hasDraft = input.trim() !== "";

	const handleSend = () => {
		if (hasDraft && canSend) {
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
			{onStop && slotShowsStop({ turnOpen, canSend, hasDraft, disabled }) ? (
				// Armed after arriving: it lands under the thumb that just sent.
				<Armed>
					<button
						type="button"
						onClick={onStop}
						aria-label="Stop"
						className="flex size-9 items-center justify-center rounded-full bg-th-error text-th-text-inverse pointer-coarse:size-11"
					>
						<Square className="size-3.5 fill-current" />
					</button>
				</Armed>
			) : (
				<button
					type="button"
					onClick={handleSend}
					disabled={disabled || !canSend || !hasDraft}
					aria-label="Send"
					className="flex size-9 items-center justify-center rounded-full bg-th-accent text-th-text-inverse disabled:opacity-50 pointer-coarse:size-11"
				>
					<Send className="size-5" />
				</button>
			)}
		</div>
	);
}
