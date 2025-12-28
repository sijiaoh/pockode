import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { inputActions, useInputStore } from "../../lib/inputStore";
import { isMobile } from "../../utils/breakpoints";

interface Props {
	sessionId: string;
	onSend: (content: string) => void;
	disabled?: boolean;
	isStreaming?: boolean;
	onInterrupt?: () => void;
}

function InputBar({
	sessionId,
	onSend,
	disabled = false,
	isStreaming = false,
	onInterrupt,
}: Props) {
	const input = useInputStore((state) => state.inputs[sessionId] ?? "");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when input changes to adjust height
	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.style.height = "auto";
			textarea.style.height = `${textarea.scrollHeight}px`;
		}
	}, [input]);

	const handleSend = useCallback(() => {
		const trimmed = input.trim();
		if (trimmed && !disabled && !isStreaming) {
			onSend(trimmed);
			inputActions.clear(sessionId);
		}
	}, [input, onSend, disabled, isStreaming, sessionId]);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
				e.preventDefault();
				handleSend();
			}
		},
		[handleSend],
	);

	return (
		<div className="border-t border-th-border p-3 sm:p-4">
			<div className="flex items-end gap-2">
				<textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => inputActions.set(sessionId, e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={
						isMobile()
							? "Type a message..."
							: "Type a message... (Shift+Enter for newline)"
					}
					disabled={disabled}
					rows={1}
					className="min-h-[44px] max-h-[40vh] flex-1 resize-none overflow-y-auto rounded-lg bg-th-bg-secondary px-3 py-2 text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:ring-2 focus:ring-th-border-focus disabled:opacity-50 sm:max-h-[200px] sm:px-4"
				/>
				{isStreaming ? (
					<button
						type="button"
						onClick={onInterrupt}
						className="min-h-[44px] rounded-lg bg-th-error px-3 py-2 text-th-text-inverse hover:opacity-90 sm:px-4"
					>
						Stop
						<span className="hidden text-xs opacity-70 sm:inline"> Esc</span>
					</button>
				) : (
					<button
						type="button"
						onClick={handleSend}
						disabled={disabled || !input.trim()}
						className="min-h-[44px] rounded-lg bg-th-accent px-3 py-2 text-th-accent-text hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}

export default InputBar;
