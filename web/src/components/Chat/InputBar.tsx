import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import { useInputHistory } from "../../hooks/useInputHistory";
import { inputActions, useInputStore } from "../../lib/inputStore";
import type { Command } from "../../lib/rpc";
import { useWSStore } from "../../lib/wsStore";
import { hasCoarsePointer, isMobile } from "../../utils/breakpoints";
import CommandPalette, { useFilteredCommands } from "./CommandPalette";
import CommandTrigger from "./CommandTrigger";

interface Props {
	sessionId: string;
	onSend: (content: string) => void;
	canSend?: boolean;
	isStreaming?: boolean;
	onInterrupt?: () => void;
}

// Slash command pattern per Claude Code naming conventions.
// Keep in sync with server/command/store.go namePattern.
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?)?$/;

function InputBar({
	sessionId,
	onSend,
	canSend = true,
	isStreaming = false,
	onInterrupt,
}: Props) {
	const input = useInputStore((state) => state.inputs[sessionId] ?? "");
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const { saveToHistory, getPrevious, getNext, resetNavigation } =
		useInputHistory();

	const [commands, setCommands] = useState<Command[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [paletteDismissed, setPaletteDismissed] = useState(false);
	const { listCommands, invalidateCommandCache } = useWSStore((s) => s.actions);

	// Palette shows when input matches valid command pattern, unless manually dismissed
	const isSlashMode = COMMAND_PATTERN.test(input);
	const isPaletteOpen = isSlashMode && !paletteDismissed;
	const filter = isPaletteOpen ? input.slice(1) : "";

	// Reset dismissed state when input changes to exactly "/" (fresh slash command start)
	// or when "/" is removed from input
	useEffect(() => {
		if (input === "/" || !input.startsWith("/")) {
			setPaletteDismissed(false);
		}
	}, [input]);

	const filteredCommands = useFilteredCommands(commands, filter);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when filter changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [filter]);

	// Focus input on session change (desktop only)
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when sessionId changes
	useEffect(() => {
		if (!isMobile()) textareaRef.current?.focus();
	}, [sessionId]);

	useEffect(() => {
		if (!isPaletteOpen) return;
		listCommands()
			.then(setCommands)
			.catch((e) => console.error("Failed to load commands:", e));
	}, [isPaletteOpen, listCommands]);

	const setInput = useCallback(
		(value: string) => inputActions.set(sessionId, value),
		[sessionId],
	);

	const closePalette = useCallback(() => {
		setPaletteDismissed(true);
		textareaRef.current?.focus();
	}, []);

	// Outside click detection
	useEffect(() => {
		if (!isPaletteOpen) return;

		const handleClickOutside = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				closePalette();
			}
		};

		// Delay to avoid triggering on the click that opened the palette
		const timeoutId = setTimeout(() => {
			document.addEventListener("mousedown", handleClickOutside);
		}, 0);

		return () => {
			clearTimeout(timeoutId);
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [isPaletteOpen, closePalette]);

	const handleTriggerClick = useCallback(() => {
		if (isPaletteOpen) {
			closePalette();
		} else if (isSlashMode) {
			// Already has "/", just reopen
			setPaletteDismissed(false);
			textareaRef.current?.focus();
		} else {
			// Prepend "/" to open palette
			setInput(`/${input}`);
			textareaRef.current?.focus();
		}
	}, [isPaletteOpen, isSlashMode, input, setInput, closePalette]);

	const handleCommandSelect = useCallback(
		(cmd: Command) => {
			setInput(`/${cmd.name} `);
			textareaRef.current?.focus();
		},
		[setInput],
	);

	const handleSend = useCallback(() => {
		const trimmed = input.trim();
		if (trimmed && canSend && !isStreaming) {
			saveToHistory(trimmed);
			resetNavigation();
			onSend(trimmed);
			inputActions.clear(sessionId);
			// Invalidate command cache when a slash command is sent
			if (trimmed.startsWith("/")) {
				invalidateCommandCache();
			}
		}
	}, [
		input,
		onSend,
		canSend,
		isStreaming,
		sessionId,
		saveToHistory,
		resetNavigation,
		invalidateCommandCache,
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

			// Palette keyboard handling
			if (isPaletteOpen) {
				if (e.key === "Escape") {
					e.preventDefault();
					closePalette();
					return;
				}

				// Arrow keys navigate the palette
				if (e.key === "ArrowUp" && filteredCommands.length > 0) {
					e.preventDefault();
					setSelectedIndex(
						(i) => (i - 1 + filteredCommands.length) % filteredCommands.length,
					);
					return;
				}

				if (e.key === "ArrowDown" && filteredCommands.length > 0) {
					e.preventDefault();
					setSelectedIndex((i) => (i + 1) % filteredCommands.length);
					return;
				}

				// Tab or Enter selects the command
				if (
					(e.key === "Tab" || e.key === "Enter") &&
					filteredCommands.length > 0
				) {
					e.preventDefault();
					handleCommandSelect(filteredCommands[selectedIndex]);
					return;
				}
			}

			// Normal input handling
			if (e.key === "Enter" && !e.shiftKey) {
				if (hasCoarsePointer()) return;
				e.preventDefault();
				handleSend();
				return;
			}

			if (e.key === "ArrowUp" && isAtFirstLine()) {
				const previous = getPrevious(input);
				if (previous !== null) {
					e.preventDefault();
					setInput(previous);
					requestAnimationFrame(moveCursorToEnd);
				}
				return;
			}

			if (e.key === "ArrowDown" && isAtLastLine()) {
				const next = getNext();
				if (next !== null) {
					e.preventDefault();
					setInput(next);
					requestAnimationFrame(moveCursorToEnd);
				}
			}
		},
		[
			isPaletteOpen,
			filteredCommands,
			selectedIndex,
			closePalette,
			handleCommandSelect,
			handleSend,
			isAtFirstLine,
			isAtLastLine,
			getPrevious,
			getNext,
			input,
			setInput,
			moveCursorToEnd,
		],
	);

	return (
		<div
			ref={containerRef}
			className="relative border-t border-th-border px-3 py-2 sm:px-4 sm:py-3"
		>
			{isPaletteOpen && (
				<CommandPalette
					commands={filteredCommands}
					selectedIndex={selectedIndex}
					onSelect={handleCommandSelect}
					filter={filter}
				/>
			)}
			<div className="flex items-end gap-2">
				<CommandTrigger onClick={handleTriggerClick} isActive={isPaletteOpen} />
				<TextareaAutosize
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={
						hasCoarsePointer()
							? "Type a message..."
							: "Type a message... (Shift+Enter for newline)"
					}
					spellCheck={false}
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					className="min-h-9 max-h-[40vh] flex-1 resize-none overflow-y-auto rounded-lg bg-th-bg-secondary px-3 py-1.5 text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:ring-2 focus:ring-th-border-focus sm:max-h-[200px] sm:px-4"
				/>
				{isStreaming ? (
					<button
						type="button"
						onClick={onInterrupt}
						className="h-9 rounded-lg bg-th-error px-3 text-th-text-inverse hover:opacity-90 sm:px-4"
					>
						Stop
						<span className="hidden text-xs opacity-70 sm:inline"> Esc</span>
					</button>
				) : (
					<button
						type="button"
						onClick={handleSend}
						disabled={!canSend || !input.trim()}
						className="h-9 rounded-lg bg-th-accent px-3 text-th-accent-text hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}

export default InputBar;
