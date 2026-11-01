import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { useInputStore } from "../../lib/inputStore";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { Armed, StopButton } from "../Chat/SendStopSlot";

interface Props {
	sessionId: string;
	/** Held by the host, which also has to know whether a composer is mounted. */
	expanded: boolean;
	onExpandedChange: (expanded: boolean) => void;
	/** Offers Stop on the collapsed line. */
	turnOpen: boolean;
	onStop: () => void;
	/** The line cannot be opened: no session yet, or a send it would refuse. */
	disabled?: boolean;
	/** Why sending is refused, said where `Message…` would be. */
	blockedReason?: string;
	/**
	 * Drawn before the collapsed line, and gone with it while expanded. Not
	 * covered by `disabled`: what it offers is not a send.
	 */
	leading?: ReactNode;
	/**
	 * The ordinary composer, drawn in place of the line while expanded. Its
	 * `onSend` has to collapse this: a send is one of the two things that put
	 * it away.
	 */
	children: ReactNode;
}

/** No draft: what a blur needs to put the composer away. */
function isDraftEmpty(sessionId: string): boolean {
	const { inputs, attachments } = useInputStore.getState();
	return !inputs[sessionId]?.trim() && !attachments[sessionId]?.length;
}

/**
 * The canvas view's input (docs/canvas-ui.md §2): one line — `Message…`, and
 * Stop while a turn is open, after whatever the host leads it with — that
 * opens into the ordinary composer over the bottom of the canvas. The page is
 * the main way in; this is the fallback for what it does not offer, so it
 * takes one line until it is asked for.
 *
 * Expanded, it is drawn over the canvas by the `ComposerDock` it sits in.
 */
export function CanvasComposer({
	sessionId,
	expanded,
	onExpandedChange,
	turnOpen,
	onStop,
	disabled = false,
	blockedReason,
	leading,
	children,
}: Props) {
	const { StopButton: CustomStopButton } = useChatUIConfig();
	const lineRef = useRef<HTMLButtonElement>(null);
	const composerRef = useRef<HTMLDivElement>(null);
	const draft = useInputStore((s) => s.inputs[sessionId] ?? "");
	const fileCount = useInputStore((s) => s.attachments[sessionId]?.length ?? 0);

	const draftLine = draft.trim().split("\n")[0];
	const lineText =
		draftLine ||
		(fileCount > 0
			? `${fileCount} ${fileCount === 1 ? "file" : "files"} attached`
			: disabled && blockedReason
				? blockedReason
				: "Message…");

	// Opened and focused within the press, synchronously: a focus a frame
	// later is not the user's tap on iOS, and brings up no keyboard.
	const expand = () => {
		flushSync(() => onExpandedChange(true));
		composerRef.current
			?.querySelector<HTMLElement>("textarea, input:not([type=file])")
			?.focus();
	};

	// A prefill handed in from outside the chat is made noticeable by the
	// composer (docs/agent-handoff-ui.md §1.3), which the line is not: it is
	// opened for it, and takes the reveal as it mounts.
	const revealPending = useInputStore(
		(s) => s.reveals[sessionId] !== undefined,
	);
	useEffect(() => {
		if (revealPending && !expanded && !disabled) onExpandedChange(true);
	}, [revealPending, expanded, disabled, onExpandedChange]);

	// A send unmounts the composer under the caret, which drops focus onto
	// `<body>`; the line it collapsed into is where it was.
	const wasExpanded = useRef(expanded);
	useLayoutEffect(() => {
		const collapsed = wasExpanded.current && !expanded;
		wasExpanded.current = expanded;
		if (collapsed && document.activeElement === document.body) {
			lineRef.current?.focus();
		}
	}, [expanded]);

	// Asked once focus has landed, and not after the composer is gone. A mouse
	// moves focus on the press, so a collapse then would move what is under
	// the pointer before the button comes up, and the click would miss: the
	// press is let finish first. A finger moves it at the click, done already.
	const blurCheck = useRef<ReturnType<typeof setTimeout>>(undefined);
	const pressing = useRef(false);
	useEffect(() => {
		if (!expanded) return;
		const down = () => {
			pressing.current = true;
		};
		const up = () => {
			pressing.current = false;
		};
		document.addEventListener("pointerdown", down, true);
		document.addEventListener("pointerup", up, true);
		document.addEventListener("pointercancel", up, true);
		// A press whose release went to another window.
		window.addEventListener("blur", up);
		return () => {
			pressing.current = false;
			clearTimeout(blurCheck.current);
			document.removeEventListener("pointerdown", down, true);
			document.removeEventListener("pointerup", up, true);
			document.removeEventListener("pointercancel", up, true);
			window.removeEventListener("blur", up);
		};
	}, [expanded]);

	if (expanded) {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: listens to focus leaving the composer; nothing here is a control
			<div
				ref={composerRef}
				onBlur={(e) => {
					const composer = e.currentTarget;
					if (composer.contains(e.relatedTarget)) return;
					// The window losing focus — a file picker opened from the
					// composer's own menu — leaves the active element where it
					// was, and is not the user leaving: collapsing would unmount
					// the picker's input under it.
					const check = () => {
						if (pressing.current) {
							blurCheck.current = setTimeout(check, 50);
							return;
						}
						if (composer.contains(document.activeElement)) return;
						if (isDraftEmpty(sessionId)) onExpandedChange(false);
					};
					clearTimeout(blurCheck.current);
					blurCheck.current = setTimeout(check);
				}}
			>
				{children}
			</div>
		);
	}

	return (
		<div className="border-t border-th-border">
			<div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-3 py-2 sm:px-4">
				{leading}
				<button
					ref={lineRef}
					type="button"
					onClick={expand}
					disabled={disabled}
					className={`min-h-9 min-w-0 flex-1 truncate rounded-lg bg-th-bg-secondary px-3 text-left pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-border-focus disabled:cursor-not-allowed disabled:opacity-50 sm:px-4 ${
						draftLine ? "text-th-text-primary" : "text-th-text-muted"
					}`}
				>
					{lineText}
				</button>
				{/* Mounted afresh on every collapse, so it arms again: a send puts
				    it where Send was, under the thumb that pressed it. */}
				{turnOpen && CustomStopButton !== null && (
					<Armed>
						<StopButton
							onStop={onStop}
							custom={CustomStopButton ?? undefined}
						/>
					</Armed>
				)}
			</div>
		</div>
	);
}

/**
 * The bars under the canvas — the strips, the error bars and the input — as one
 * block, which floats over the bottom of the canvas while `floating` and is in
 * the column otherwise.
 *
 * Floating, it keeps the height it last had in the column with the composer
 * closed (`open` false), so the canvas area keeps its size whatever the
 * composer grows to (docs/canvas-ui.md §2, §5); and the bars ride up on top of
 * the composer rather than being covered by it. Not a height taken with the
 * composer open in the column — under the answer panel, or too tall to float —
 * which floating again would leave squeezing the canvas, and the size rule
 * would then take for the canvas's. One element either way, so nothing in it
 * is mounted again by the change.
 *
 * A block taller than the whole column — a short landscape screen, the keyboard
 * up, a long draft — goes back into it rather than float over the header: in
 * the column it is the canvas that gives way, as the transcript does in chat
 * view. Neither height it compares depends on where the block is, so this
 * cannot flip back.
 */
export function ComposerDock({
	floating,
	open,
	children,
}: {
	floating: boolean;
	/** The composer is open; only ever floats while it is. */
	open: boolean;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const inFlowHeight = useRef(0);
	const [tooTall, setTooTall] = useState(false);
	const floats = floating && !tooTall;

	// Read in every commit as well as on resizes: the observer reports after
	// layout, so a commit that changes what is in the dock (the line taking
	// the chat bar's place) and the composer opening right after it would
	// otherwise float it at the height from before.
	useLayoutEffect(() => {
		const dock = ref.current;
		if (!floats && !open && dock) inFlowHeight.current = dock.offsetHeight;
	});
	useEffect(() => {
		const dock = ref.current;
		if (floats || open || !dock) return;
		const observer = new ResizeObserver(() => {
			inFlowHeight.current = dock.offsetHeight;
		});
		observer.observe(dock);
		return () => observer.disconnect();
	}, [floats, open]);

	useLayoutEffect(() => {
		const dock = ref.current;
		const content = contentRef.current;
		const column = dock?.parentElement;
		if (!floating || !dock || !content || !column) {
			setTooTall(false);
			return;
		}
		// The column's own height, not where the dock ends: back in the column
		// a block too tall for it runs past its bottom.
		const measure = () =>
			setTooTall(content.offsetHeight > column.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(column);
		observer.observe(content);
		return () => observer.disconnect();
	}, [floating]);

	return (
		<div
			ref={ref}
			className="relative shrink-0"
			style={floats ? { height: inFlowHeight.current } : undefined}
		>
			<div
				ref={contentRef}
				className={
					floats
						? "absolute inset-x-0 bottom-0 z-10 flex flex-col bg-th-bg-primary"
						: "flex flex-col"
				}
			>
				{children}
			</div>
		</div>
	);
}
