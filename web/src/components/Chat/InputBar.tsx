import {
	hasCoarsePointer,
	useCoverPage,
	useHasCoarsePointer,
	useIsPageCovered,
	useOutsideClick,
} from "@pockode/shared";
import { ArrowUp, Image, Paperclip, Plus, Slash, Square } from "lucide-react";
import {
	type ChangeEvent,
	type ClipboardEvent,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import getCaretCoordinates from "textarea-caret";
import { type DroppedFiles, readPasted } from "../../hooks/useFileDragZone";
import { useInputHistory } from "../../hooks/useInputHistory";
import type { ChatAttachment } from "../../lib/chatAttachments";
import {
	attachmentActions,
	type ComposerReveal,
	type DraftAttachment,
	inputActions,
	useInputStore,
} from "../../lib/inputStore";
import {
	type SendOutcome,
	useChatUIConfig,
} from "../../lib/registries/chatUIRegistry";
import type { Command } from "../../lib/rpc";
import { useWSStore } from "../../lib/wsStore";
import { isMac } from "../../utils/platform";
import CommandPalette, { useFilteredCommands } from "./CommandPalette";
import ComposerAttachments from "./ComposerAttachments";
import ComposerMenu, {
	type ComposerMenuItem,
	focusMenuItem,
} from "./ComposerMenu";
import { Armed, slotShowsStop } from "./SendStopSlot";

interface Props {
	sessionId: string;
	/** See `InputBarProps.onSend`. */
	onSend: (
		content: string,
		attachments?: ChatAttachment[],
	) => Promise<SendOutcome>;
	canSend?: boolean;
	/** See `InputBarProps.sendBlockedReason`. */
	sendBlockedReason?: string;
	/**
	 * Session not resolved yet (mid switch). Unlike `canSend={false}`, which only
	 * blocks sending while the current session's history loads, this closes the
	 * bar entirely: there is no session to type at yet.
	 */
	disabled?: boolean;
	/**
	 * A turn is under way — read for whether the action slot offers Stop, never
	 * to refuse a send. `InputBarProps` in the chat UI registry states why.
	 */
	turnOpen?: boolean;
	onStop?: () => void;
	/** See `InputBarProps.focusRequest`. */
	focusRequest?: number;
	/** See `InputBarProps.focusOnOpen`. */
	focusOnOpen?: boolean;
	/**
	 * Takes files pasted into the textarea; absent where the host would refuse
	 * them, which leaves the paste to the browser. The host's rather than the
	 * bar's because a refused folder is reported above the bar, by the host.
	 */
	onPasteFiles?: (pasted: DroppedFiles) => void;
}

// Slash command pattern per Claude Code naming conventions.
// Keep in sync with server/command/store.go namePattern.
const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)?)?$/;

const NO_ATTACHMENTS: DraftAttachment[] = [];

function InputBar({
	sessionId,
	onSend,
	canSend = true,
	sendBlockedReason,
	disabled = false,
	turnOpen = false,
	onStop,
	focusRequest = 0,
	focusOnOpen = true,
	onPasteFiles,
}: Props) {
	const input = useInputStore((state) => state.inputs[sessionId] ?? "");
	const files = useInputStore(
		(state) => state.attachments[sessionId] ?? NO_ATTACHMENTS,
	);
	const isPrimaryPointerCoarse = useHasCoarsePointer();
	const { StopButton: CustomStopButton } = useChatUIConfig();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const addRef = useRef<HTMLDivElement>(null);
	const addButtonRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const photoInputRef = useRef<HTMLInputElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { saveToHistory, getPrevious, getNext, resetNavigation } =
		useInputHistory();

	const [commands, setCommands] = useState<Command[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [paletteDismissed, setPaletteDismissed] = useState(false);
	// `keyboard` when it was opened without a pointer, which is what decides
	// whether focus moves into it.
	const [menu, setMenu] = useState<"closed" | "pointer" | "keyboard">("closed");
	const isMenuOpen = menu !== "closed";
	const listCommands = useWSStore((s) => s.actions.listCommands);

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

	// Where a prefill put in at the caret goes (`inputActions.registerCaret`).
	// Placed means the field has been focused since it was drawn for this
	// session, or is focused now: one that kept focus through a session switch
	// is typed in without another focus event. Ahead of the autofocus below,
	// so the reset never undoes the focus that gives.
	//
	// `heldCaret` is where an insert left it on a touch screen with the field
	// unfocused: placing it there would raise the keyboard, and the DOM caret
	// went to the end when the draft was written — so a second insert would
	// land under the user's last words instead of under the first block. A tap
	// in the field places the caret itself, and drops it; so does any other
	// rewrite of the draft (Send again), which the offset no longer points into.
	const caretPlaced = useRef(false);
	const heldCaret = useRef<{ at: number; draft: string } | null>(null);
	useEffect(() => {
		caretPlaced.current = false;
		heldCaret.current = null;
		return inputActions.registerCaret(sessionId, () => {
			const textarea = textareaRef.current;
			if (!textarea) return null;
			if (heldCaret.current?.draft === textarea.value) {
				return heldCaret.current.at;
			}
			const placed = caretPlaced.current || document.activeElement === textarea;
			return placed ? textarea.selectionEnd : null;
		});
	}, [sessionId]);

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
	//
	// A focus request is answered the same way, for the same reason — and even
	// where opening takes no focus, since it is the host asking. Counted as
	// answered only once the bar is enabled, so one made while it is disabled
	// is still answered when it comes back. Leaving a page that took no focus
	// for one that does — a Git detail for the chat — counts as opening: the
	// bar stays mounted across it, so no remount opens it.
	const answeredFocusRequest = useRef(focusRequest);
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when sessionId changes, focus is requested or opening starts taking focus
	useEffect(() => {
		if (disabled) return;
		const requested = focusRequest !== answeredFocusRequest.current;
		answeredFocusRequest.current = focusRequest;
		if (!focusOnOpen && !requested) return;
		const textarea = textareaRef.current;
		if (isPrimaryPointerCoarse || !textarea) return;
		if (document.activeElement === textarea) return;
		textarea.focus();
		// At the end: a field drawn with a saved draft can have its caret ahead
		// of it, where typing — and a prefill at the caret — would go first.
		const end = textarea.value.length;
		textarea.setSelectionRange(end, end);
	}, [sessionId, disabled, focusRequest, focusOnOpen]);

	// A prefill handed in from outside the chat, made noticeable once
	// (docs/agent-handoff-ui.md §1.3). Taken only once the bar is enabled: a
	// session just created is still resolving when the bar first renders it.
	// And only once nothing covers the page: a handoff made from a page that
	// keeps this bar — a menu row in a sheet over a Git detail — lands while
	// the sheet is still up, and the sheet hands focus back to its opener as it
	// closes, taking the caret from the draft and the ring from view.
	const reveal = useInputStore((state) => state.reveals[sessionId]);
	const isPageCovered = useIsPageCovered();
	const [arrival, setArrival] = useState<ComposerReveal | null>(null);
	// Ahead of the effect below, so a reveal waiting for the session being
	// opened is set after the previous session's is cleared.
	// biome-ignore lint/correctness/useExhaustiveDependencies: an arrival belongs to the session it was made for
	useEffect(() => {
		setArrival(null);
	}, [sessionId]);

	useEffect(() => {
		if (!reveal || disabled || isPageCovered) return;
		inputActions.takeReveal(sessionId);
		const textarea = textareaRef.current;
		if (textarea) {
			// Explicitly at the end after an append: a caret anywhere else would be
			// in the middle of the user's own words. After an insert, just under
			// what went in. The pointer gate is the autofocus rule's — except that
			// a field already holding the keyboard raises nothing, and its caret
			// is where the next key goes.
			const end = textarea.value.length;
			const caret = Math.min(reveal.caret ?? end, end);
			if (!isPrimaryPointerCoarse || document.activeElement === textarea) {
				textarea.focus();
				textarea.setSelectionRange(caret, caret);
				heldCaret.current = null;
			} else {
				heldCaret.current =
					reveal.caret === undefined
						? null
						: { at: caret, draft: textarea.value };
			}
			scrollToCaret(textarea, caret);
		}
		setArrival(reveal.landed);
	}, [reveal, disabled, isPageCovered, sessionId, isPrimaryPointerCoarse]);

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

	// Outside click detection. The palette hangs over the composer with no
	// backdrop, at every width, so the click that dismisses it reaches whatever
	// is behind — the chat's answer panel dims the transcript and treats a press
	// there as its own dismissal. Claiming it keeps one press to one panel; the
	// palette's Escape does the same with `preventDefault`.
	useOutsideClick(isPaletteOpen, (target, event) => {
		if (containerRef.current && !containerRef.current.contains(target)) {
			event.stopPropagation();
			closePalette();
		}
	});

	// The menu and the palette hang from the same place, so one opening puts
	// the other away. Typing "/" is the palette's other door, and it can be
	// used with the menu up: a pointer leaves the caret in the textarea.
	useEffect(() => {
		if (isPaletteOpen) setMenu("closed");
	}, [isPaletteOpen]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a menu opened over one session is not the next one's
	useEffect(() => {
		setMenu("closed");
	}, [sessionId, disabled]);

	useCoverPage(isMenuOpen);

	// For a control that is about to leave the screen with focus on it — a
	// menu row, Send giving way to Stop. Focus goes to the draft, except where
	// that would raise an on-screen keyboard nobody asked for: the autofocus
	// rule above. A press made from the keyboard has one, so it always goes.
	const returnFocusToDraft = useCallback(
		(fromKeyboard: boolean) => {
			if (fromKeyboard || !isPrimaryPointerCoarse) {
				textareaRef.current?.focus();
			}
		},
		[isPrimaryPointerCoarse],
	);

	// Focus in a row means the menu is being driven from the keyboard, however
	// it was opened.
	const closeMenu = useCallback(() => {
		const fromKeyboard =
			menu === "keyboard" ||
			(menuRef.current?.contains(document.activeElement) ?? false);
		setMenu("closed");
		returnFocusToDraft(fromKeyboard);
	}, [menu, returnFocusToDraft]);

	const handleMenuTabOut = useCallback((backward: boolean) => {
		setMenu("closed");
		(backward ? addButtonRef.current : textareaRef.current)?.focus();
	}, []);

	// Escape from wherever focus is — the draft, the `+`, a row. Claimed with
	// `preventDefault`, and the menu counts as covering the page, so neither
	// the chat's interrupt nor the answer panel takes the same press.
	useEffect(() => {
		if (!isMenuOpen) return;
		const handleEscape = (e: globalThis.KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			closeMenu();
		};
		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [isMenuOpen, closeMenu]);

	// No backdrop, as with the palette, so the press it closes on is claimed.
	// Focus is left alone: it went wherever that press put it.
	useOutsideClick(isMenuOpen, (target, event) => {
		if (addRef.current && !addRef.current.contains(target)) {
			event.stopPropagation();
			setMenu("closed");
		}
	});

	const handleAddClick = useCallback(
		(e: MouseEvent<HTMLButtonElement>) => {
			if (isMenuOpen) {
				closeMenu();
				return;
			}
			if (isPaletteOpen) setPaletteDismissed(true);
			// `detail` counts presses; Enter and Space on a focused button make none.
			setMenu(e.detail === 0 ? "keyboard" : "pointer");
		},
		[isMenuOpen, isPaletteOpen, closeMenu],
	);

	const openCommands = useCallback(() => {
		if (isSlashMode) {
			setPaletteDismissed(false);
		} else {
			setInput(`/${input}`);
		}
	}, [isSlashMode, input, setInput]);

	// New rows go last, so the ones already learned stay where they are.
	const menuItems: ComposerMenuItem[] = [
		{ id: "commands", icon: Slash, label: "Commands", onSelect: openCommands },
		{
			id: "photos",
			icon: Image,
			label: "Photos",
			onSelect: () => photoInputRef.current?.click(),
		},
		{
			id: "files",
			icon: Paperclip,
			label: "Files",
			onSelect: () => fileInputRef.current?.click(),
		},
	];

	const handlePick = useCallback(
		(e: ChangeEvent<HTMLInputElement>) => {
			const picked = Array.from(e.target.files ?? []);
			// Cleared so picking the same file again, after removing it, still
			// fires a change.
			e.target.value = "";
			if (picked.length > 0) attachmentActions.add(sessionId, picked);
		},
		[sessionId],
	);

	const handlePaste = useCallback(
		(e: ClipboardEvent<HTMLTextAreaElement>) => {
			if (!onPasteFiles) return;
			const pasted = readPasted(e.clipboardData);
			if (!pasted) return;
			e.preventDefault();
			onPasteFiles(pasted);
		},
		[onPasteFiles],
	);

	const handleCommandSelect = useCallback(
		(cmd: Command) => {
			setInput(`/${cmd.name} `);
			textareaRef.current?.focus();
		},
		[setInput],
	);

	// `canSend` is checked here rather than only on the button, because the button
	// is the affordance and not the guard: Enter reaches this without going near
	// it, so a rule written only on `disabled` is a rule the keyboard does not
	// have.
	//
	// Files go with the message only once every one of them is uploaded; one
	// still uploading or failed holds the send rather than being left behind.
	const hasFiles = files.length > 0;
	const filesReady = hasFiles && files.every((f) => f.status === "ready");
	const sendable = canSend && (hasFiles ? filesReady : input.trim() !== "");
	const handleSend = useCallback(() => {
		if (!sendable) return;
		const trimmed = input.trim();
		if (trimmed) {
			saveToHistory(trimmed);
			resetNavigation();
		}
		const taken = attachmentActions.take(sessionId);
		const uploaded = taken.flatMap((f) => (f.uploaded ? [f.uploaded] : []));
		if (taken.length === 0) {
			onSend(trimmed);
		} else {
			onSend(trimmed, uploaded).then(
				(outcome) => {
					// A refused message was never sent, so its files come back to be
					// sent again or removed; the host does the same for the text.
					if (outcome === "refused")
						attachmentActions.restore(sessionId, taken);
					else attachmentActions.release(taken);
				},
				// The contract has no rejection, but a host that throws anyway must
				// not take the user's files with it.
				() => attachmentActions.restore(sessionId, taken),
			);
		}
		inputActions.clear(sessionId);
		setMenu("closed");
	}, [sendable, input, onSend, sessionId, saveToHistory, resetNavigation]);

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

			// A pointer opens the menu with the caret still here, so the arrows
			// that would walk history walk into the menu instead.
			if (isMenuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
				e.preventDefault();
				focusMenuItem(
					menuRef.current,
					e.key === "ArrowDown" ? "first" : "last",
				);
				return;
			}

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
			isMenuOpen,
			isPaletteOpen,
			filteredCommands,
			selectedIndex,
			closePalette,
			handleCommandSelect,
			handleSend,
		],
	);

	// A draft to the slot is one Send can take: a file stuck uploading or
	// failed — with or without text beside it — would otherwise hold a disabled
	// Send where Stop goes.
	const hasDraft = hasFiles ? filesReady : input.trim() !== "";
	const showStop =
		CustomStopButton !== null &&
		slotShowsStop({ turnOpen, canSend, hasDraft, disabled });

	// The slot also swaps under focus the user did not move: Stop pressed from
	// the keyboard gives way to Send when the turn ends, and a permission request
	// puts Stop where a focused Send was. Whether that focus was the keyboard's
	// is read when it arrives — once the button is gone there is nothing left to
	// ask. `null` is focus elsewhere.
	const slotFocusRef = useRef<boolean | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on the swap itself
	useEffect(() => {
		const fromKeyboard = slotFocusRef.current;
		if (fromKeyboard === null) return;
		slotFocusRef.current = null;
		if (document.activeElement === document.body) {
			returnFocusToDraft(fromKeyboard);
		}
	}, [showStop]);

	return (
		<div className="border-t border-th-border">
			{/* Held to the transcript's reading column, padding included, so the
			    `+` and the send slot line up with the messages' edges — and so
			    do the palette and the menu, which hang from this box. */}
			<div
				ref={containerRef}
				className={`relative mx-auto w-full max-w-3xl px-3 py-2 sm:px-4 sm:py-3 ${
					arrival ? "composer-arrival" : ""
				}`}
				onAnimationEnd={(e) => {
					if (e.target === e.currentTarget) setArrival(null);
				}}
			>
				<span className="sr-only" aria-live="polite">
					{arrival === "ready"
						? "Message ready to send."
						: arrival === "added"
							? "Added to your message."
							: ""}
				</span>
				{hasFiles && (
					<ComposerAttachments
						items={files}
						onRemove={(key) => attachmentActions.remove(sessionId, key)}
					/>
				)}
				{isPaletteOpen && (
					<CommandPalette
						commands={filteredCommands}
						selectedIndex={selectedIndex}
						onSelect={handleCommandSelect}
						filter={filter}
					/>
				)}
				{/* All three grow together under a thumb. The hit-area floor only
				    requires the buttons to grow, but the row is `items-end`, so
				    raising them alone would leave a short textarea hanging off the
				    bottom of a taller row. The textarea is autosized, so its height
				    is its content rather than its `min-h`: a 16px font on a 1.5 line
				    box is one 24px line, and the padding makes up the rest of each
				    floor (`py-1.5` -> 36, `py-2.5` -> 44). More padding than that
				    stands the box proud of the buttons instead of level with them.
				    `items-end` also keeps both buttons on the last line, under the
				    thumb, as the draft grows. */}
				<div className="flex items-end gap-2">
					<div ref={addRef} className="relative flex shrink-0">
						{isMenuOpen && (
							<ComposerMenu
								id={menuId}
								items={menuItems}
								onSelect={(item) => {
									closeMenu();
									item.onSelect();
								}}
								menuRef={menuRef}
								focusOnOpen={menu === "keyboard"}
								onTabOut={handleMenuTabOut}
							/>
						)}
						{/* `onMouseDown` keeps the caret in the draft: on a phone the
						    textarea losing focus drops the keyboard, only for it to
						    come back once a row is chosen. */}
						<button
							ref={addButtonRef}
							type="button"
							onClick={handleAddClick}
							onMouseDown={(e) => e.preventDefault()}
							disabled={disabled}
							aria-label="Add"
							aria-haspopup="menu"
							aria-expanded={isMenuOpen}
							aria-controls={isMenuOpen ? menuId : undefined}
							className={`flex size-9 items-center justify-center rounded-lg pointer-coarse:size-11 disabled:cursor-not-allowed disabled:opacity-50 ${
								isMenuOpen
									? "bg-th-accent text-th-accent-text"
									: "bg-th-bg-tertiary text-th-text-secondary hover:text-th-text-primary"
							}`}
						>
							<Plus className="size-5" aria-hidden="true" />
						</button>
						{/* `image/*` is what puts the photo library first on a phone, and
						    `video/*` is what lets it show the videos there — screen
						    recordings included — which `image/*` alone hides. */}
						<input
							ref={photoInputRef}
							type="file"
							accept="image/*,video/*"
							multiple
							hidden
							onChange={handlePick}
							data-testid="photo-input"
						/>
						<input
							ref={fileInputRef}
							type="file"
							multiple
							hidden
							onChange={handlePick}
							data-testid="file-input"
						/>
					</div>
					<TextareaAutosize
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						onKeyUp={handleKeyUp}
						onPaste={handlePaste}
						onFocus={() => {
							caretPlaced.current = true;
							heldCaret.current = null;
						}}
						// The autosizer measures the placeholder when the draft is
						// empty, so a reason that wraps on a narrow phone would grow
						// the bar by a line exactly as a permission request arrives.
						maxRows={input === "" ? 1 : undefined}
						placeholder={
							!canSend && sendBlockedReason
								? sendBlockedReason
								: hasCoarsePointer()
									? "Type a message..."
									: "Type a message... (Shift+Enter for newline)"
						}
						disabled={disabled}
						spellCheck={false}
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						className="min-h-9 max-h-[40vh] min-w-0 flex-1 resize-none pointer-coarse:min-h-11 overflow-y-auto rounded-lg bg-th-bg-secondary px-3 py-1.5 pointer-coarse:py-2.5 text-th-text-primary placeholder:text-th-text-muted placeholder:truncate focus:outline-none focus:ring-2 focus:ring-th-border-focus sm:max-h-[200px] sm:px-4"
					/>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: listens for focus passing through, takes no input of its own */}
					<div
						className="contents"
						onFocus={(e) => {
							slotFocusRef.current = e.target.matches(":focus-visible");
						}}
						onBlur={(e) => {
							if (!e.currentTarget.contains(e.relatedTarget)) {
								slotFocusRef.current = null;
							}
						}}
					>
						{onStop && showStop ? (
							<Armed>
								{CustomStopButton ? (
									<CustomStopButton onStop={onStop} />
								) : (
									<button
										type="button"
										onClick={onStop}
										aria-label="Stop"
										className="flex size-9 items-center justify-center rounded-lg bg-th-text-primary pointer-coarse:size-11 text-th-text-inverse transition-all hover:opacity-90 active:scale-95"
									>
										<Square className="size-3.5 fill-current" />
									</button>
								)}
							</Armed>
						) : (
							<button
								type="button"
								onClick={(e) => {
									handleSend();
									// Stop may take this button's place, and the focus with it.
									returnFocusToDraft(e.detail === 0);
								}}
								disabled={disabled || !sendable}
								aria-label="Send"
								className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-th-accent pointer-coarse:size-11 text-th-accent-text hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
							>
								<ArrowUp className="size-5" aria-hidden="true" />
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * Scrolls a field that has grown past its height to `caret`: to the bottom for
 * one at the end, and with the caret's line mid-field otherwise, so the text
 * just put in above it is in view.
 */
function scrollToCaret(textarea: HTMLTextAreaElement, caret: number) {
	if (caret >= textarea.value.length) {
		textarea.scrollTop = textarea.scrollHeight;
		return;
	}
	const { top } = getCaretCoordinates(textarea, caret);
	textarea.scrollTop = Math.max(0, top - textarea.clientHeight / 2);
}

export default InputBar;
