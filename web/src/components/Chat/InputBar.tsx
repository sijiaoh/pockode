import {
	hasCoarsePointer,
	useHasCoarsePointer,
	useOutsideClick,
} from "@pockode/shared";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import getCaretCoordinates from "textarea-caret";
import { useInputHistory } from "../../hooks/useInputHistory";
import { inputActions, useInputStore } from "../../lib/inputStore";
import type { Command } from "../../lib/rpc";
import { useWSStore } from "../../lib/wsStore";
import { isMac } from "../../utils/platform";
import CommandPalette, { useFilteredCommands } from "./CommandPalette";
import CommandTrigger from "./CommandTrigger";

interface Props {
	sessionId: string;
	onSend: (content: string) => void;
	canSend?: boolean;
	/**
	 * Session not resolved yet (mid switch). Unlike `canSend={false}`, which only
	 * blocks sending while the current session's history loads, this closes the
	 * bar entirely: there is no session to type at yet.
	 */
	disabled?: boolean;
}

// Slash command pattern per Claude Code naming conventions.
// Keep in sync with server/command/store.go namePattern.
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?)?$/;

function InputBar({
	sessionId,
	onSend,
	canSend = true,
	disabled = false,
}: Props) {
	const input = useInputStore((state) => state.inputs[sessionId] ?? "");
	const isPrimaryPointerCoarse = useHasCoarsePointer();
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

	// Focus input on session change. Also re-runs when the bar is re-enabled: a
	// switch disables it before this effect can focus, and without the second
	// pass the input would stay unfocused on the session just opened.
	//
	// Gated on the pointer, not the width: what makes autofocus welcome is a
	// physical keyboard, and a narrow desktop window has one while a wide tablet
	// does not — focusing there throws up the on-screen keyboard over half the
	// conversation the user just opened. The primary pointer is the right
	// question (a touchscreen laptop is driven by its trackpad and does want
	// focus), so this is `hasCoarsePointer`, not the any-pointer gate hit areas
	// use.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when sessionId changes
	useEffect(() => {
		if (disabled) return;
		if (!isPrimaryPointerCoarse) textareaRef.current?.focus();
	}, [sessionId, disabled]);

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
	useOutsideClick(isPaletteOpen, (target) => {
		if (containerRef.current && !containerRef.current.contains(target)) {
			closePalette();
		}
	});

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
		if (trimmed && canSend) {
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
		sessionId,
		saveToHistory,
		resetNavigation,
		invalidateCommandCache,
	]);

	// Track pending history navigation to check cursor Y position on keyup
	const pendingHistoryNav = useRef<{
		direction: "up" | "down";
		key: string;
		caretYBefore: number;
	} | null>(null);
	const inputRef = useRef(input);
	inputRef.current = input;

	const moveCursorToEnd = useCallback(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			const len = textarea.value.length;
			textarea.setSelectionRange(len, len);
		}
	}, []);

	// Handle keyup to check if cursor Y position didn't change after arrow key
	const handleKeyUp = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			const pending = pendingHistoryNav.current;
			if (!pending) return;

			// Only process if the released key matches the key that started navigation
			if (e.key !== pending.key) return;

			pendingHistoryNav.current = null;

			const textarea = e.currentTarget;
			const caretYAfter = getCaretCoordinates(
				textarea,
				textarea.selectionStart,
			).top;

			// Navigate history only if caret Y didn't change (already at visual boundary)
			if (caretYAfter !== pending.caretYBefore) return;

			if (pending.direction === "up") {
				const previous = getPrevious(inputRef.current);
				if (previous !== null) {
					setPaletteDismissed(true); // Don't open palette for history items
					setInput(previous);
					requestAnimationFrame(moveCursorToEnd);
				}
			} else {
				const next = getNext();
				if (next !== null) {
					setPaletteDismissed(true); // Don't open palette for history items
					setInput(next);
					requestAnimationFrame(moveCursorToEnd);
				}
			}
		},
		[getPrevious, getNext, setInput, moveCursorToEnd],
	);

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

				// Arrow keys (or Ctrl+P/N on macOS) navigate the palette
				const ctrlNav = e.ctrlKey && isMac;
				const isUp = e.key === "ArrowUp" || (ctrlNav && e.key === "p");
				const isDown = e.key === "ArrowDown" || (ctrlNav && e.key === "n");

				if (isUp && filteredCommands.length > 0) {
					e.preventDefault();
					setSelectedIndex(
						(i) => (i - 1 + filteredCommands.length) % filteredCommands.length,
					);
					return;
				}

				if (isDown && filteredCommands.length > 0) {
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

			// History navigation: record caret Y position, check on keyup if it changed
			const ctrlNav = e.ctrlKey && isMac;
			const isUp = e.key === "ArrowUp" || (ctrlNav && e.key === "p");
			const isDown = e.key === "ArrowDown" || (ctrlNav && e.key === "n");

			if (isUp || isDown) {
				const textarea = e.currentTarget;
				const caretY = getCaretCoordinates(
					textarea,
					textarea.selectionStart,
				).top;
				pendingHistoryNav.current = {
					direction: isUp ? "up" : "down",
					key: e.key,
					caretYBefore: caretY,
				};
			}
		},
		[
			isPaletteOpen,
			filteredCommands,
			selectedIndex,
			closePalette,
			handleCommandSelect,
			handleSend,
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
			{/* All three grow together under a thumb. The hit-area floor only
			    requires the send button to grow, but the row is `items-end`, so
			    raising it alone would leave a short textarea hanging off the
			    bottom of a taller row. The textarea is autosized, so its height
			    is its content rather than its `min-h`: a 16px font on a 1.5 line
			    box is one 24px line, and the padding makes up the rest of each
			    floor (`py-1.5` -> 36, `py-2.5` -> 44). More padding than that
			    stands the box proud of the buttons instead of level with them. */}
			<div className="flex items-end gap-2">
				<CommandTrigger
					onClick={handleTriggerClick}
					isActive={isPaletteOpen}
					disabled={disabled}
				/>
				<TextareaAutosize
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					onKeyUp={handleKeyUp}
					placeholder={
						hasCoarsePointer()
							? "Type a message..."
							: "Type a message... (Shift+Enter for newline)"
					}
					disabled={disabled}
					spellCheck={false}
					autoComplete="off"
					autoCorrect="off"
					autoCapitalize="off"
					className="min-h-9 max-h-[40vh] flex-1 resize-none pointer-coarse:min-h-11 overflow-y-auto rounded-lg bg-th-bg-secondary px-3 py-1.5 pointer-coarse:py-2.5 text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:ring-2 focus:ring-th-border-focus sm:max-h-[200px] sm:px-4"
				/>
				<button
					type="button"
					onClick={handleSend}
					disabled={disabled || !canSend || !input.trim()}
					className="h-9 rounded-lg bg-th-accent px-3 pointer-coarse:h-11 text-th-accent-text hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
				>
					Send
				</button>
			</div>
		</div>
	);
}

export default InputBar;
