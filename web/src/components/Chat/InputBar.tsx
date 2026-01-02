import { type KeyboardEvent, useCallback, useEffect, useRef } from "react";
import { useInputHistory } from "../../hooks/useInputHistory";
import { inputActions, useInputStore } from "../../lib/inputStore";
import { isMobile } from "../../utils/breakpoints";

interface Props {
	sessionId: string;
	onSend: (content: string) => void;
	canSend?: boolean;
	isStreaming?: boolean;
	onInterrupt?: () => void;
}

function InputBar({
	sessionId,
	onSend,
	canSend = true,
	isStreaming = false,
	onInterrupt,
}: Props) {
	const input = useInputStore((state) => state.inputs[sessionId] ?? "");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const { saveToHistory, getPrevious, getNext, resetNavigation } =
		useInputHistory();

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when input changes to adjust height
	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.style.height = "auto";
			textarea.style.height = `${textarea.scrollHeight}px`;
		}
	}, [input]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when sessionId changes to focus input
	useEffect(() => {
		if (!isMobile()) textareaRef.current?.focus();
	}, [sessionId]);

	const handleSend = useCallback(() => {
		const trimmed = input.trim();
		if (trimmed && canSend && !isStreaming) {
			saveToHistory(trimmed);
			resetNavigation();
			onSend(trimmed);
			inputActions.clear(sessionId);
		}
	}, [
		input,
		onSend,
		canSend,
		isStreaming,
		sessionId,
		saveToHistory,
		resetNavigation,
	]);

	const isAtFirstLine = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) return true;
		const cursorPos = textarea.selectionStart;
		const textBeforeCursor = textarea.value.substring(0, cursorPos);
		return !textBeforeCursor.includes("\n");
	}, []);

	const isAtLastLine = useCallback(() => {
		const textarea = textareaRef.current;
		if (!textarea) return true;
		const cursorPos = textarea.selectionStart;
		const textAfterCursor = textarea.value.substring(cursorPos);
		return !textAfterCursor.includes("\n");
	}, []);

	const moveCursorToEnd = useCallback(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			const len = textarea.value.length;
			textarea.setSelectionRange(len, len);
		}
	}, []);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.nativeEvent.isComposing) return;

			if (e.key === "Enter" && !e.shiftKey) {
				if (isMobile()) return;
				e.preventDefault();
				handleSend();
				return;
			}

			if (e.key === "ArrowUp" && isAtFirstLine()) {
				const previous = getPrevious(input);
				if (previous !== null) {
					e.preventDefault();
					inputActions.set(sessionId, previous);
					requestAnimationFrame(moveCursorToEnd);
				}
				return;
			}

			if (e.key === "ArrowDown" && isAtLastLine()) {
				const next = getNext();
				if (next !== null) {
					e.preventDefault();
					inputActions.set(sessionId, next);
					requestAnimationFrame(moveCursorToEnd);
				}
			}
		},
		[
			handleSend,
			isAtFirstLine,
			isAtLastLine,
			getPrevious,
			getNext,
			input,
			sessionId,
			moveCursorToEnd,
		],
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
					rows={1}
					className="min-h-[44px] max-h-[40vh] flex-1 resize-none overflow-y-auto rounded-lg bg-th-bg-secondary px-3 py-2 text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:ring-2 focus:ring-th-border-focus sm:max-h-[200px] sm:px-4"
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
						disabled={!canSend || !input.trim()}
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
