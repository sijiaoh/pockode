import { useCoverPage } from "@pockode/shared";
import { useCallback, useEffect, useId, useRef, useState } from "react";

const SIDEBAR_WIDTH_KEY = "pockode:sidebar-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 288; // w-72
// One arrow press moves the edge by a step a sighted user can see land, and
// MIN_WIDTH..MAX_WIDTH is then about sixteen presses across.
const KEYBOARD_STEP = 16;

function getInitialWidth(): number {
	const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (saved) {
		const parsed = Number.parseInt(saved, 10);
		if (!Number.isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
			return parsed;
		}
	}
	return DEFAULT_WIDTH;
}

interface Props {
	/** On screen: the drawer open, or the column not collapsed. */
	isOpen: boolean;
	onClose: () => void;
	children: React.ReactNode;
	isExpanded: boolean;
}

function Sidebar({ isOpen, onClose, children, isExpanded }: Props) {
	const [width, setWidth] = useState(getInitialWidth);
	const [isDragging, setIsDragging] = useState(false);

	// Escape closes the drawer; the column is not an overlay and ignores it —
	// only its own button collapses it.
	// The press is marked handled, because the drawer opens from the session
	// header — which stays lit under the chat's answer panel — and that panel
	// waits until `window` to ask so this answer is in by then
	// (docs/answering-ui.md §4, "Who owns Escape"). Without the mark, one press
	// would close the drawer and a panel behind it the user cannot even see.
	useEffect(() => {
		if (isExpanded) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented || !isOpen) return;
			e.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose, isExpanded]);

	// Only the drawer covers the page; the expanded tier's column is part of it.
	// Covering is what keeps the chat's interrupt off the press that closes the
	// drawer: it is a sibling `document` listener, and if it was registered
	// first it runs before the mark above is made.
	useCoverPage(isOpen && !isExpanded);

	// Focus goes to the panel rather than to its first control, as a `Sheet`'s
	// does to the sheet: landing inside the dialog reads its name, and the first
	// stop would only be whatever control the content happens to put first.
	// Handing focus back on close is `AppShell`'s, because only it saw the
	// opener: the page behind goes `inert` in the commit that opens the drawer,
	// which drops focus off the opener before any effect here could note it.
	const drawerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (isOpen && !isExpanded) {
			drawerRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen, isExpanded]);

	// The column takes focus the same way when it is expanded back — a change of
	// `isOpen` within the tier, which only the expand button makes. Mounting
	// with the stored state and crossing tiers are not presses, so they leave
	// focus where it was.
	const columnRef = useRef<HTMLElement>(null);
	const prevRef = useRef({ isOpen, isExpanded });
	useEffect(() => {
		const prev = prevRef.current;
		prevRef.current = { isOpen, isExpanded };
		if (isExpanded && prev.isExpanded && isOpen && !prev.isOpen) {
			columnRef.current?.focus({ preventScroll: true });
		}
	}, [isOpen, isExpanded]);

	// The handle is only on screen in the expanded tier and while the column is
	// not collapsed, so a viewport shrinking out of the tier or a collapse takes
	// the drag with it: the handle is gone before any pointerup or
	// pointercancel can reach it, and without this the drag stays live forever.
	useEffect(() => {
		if (!isExpanded || !isOpen) setIsDragging(false);
	}, [isExpanded, isOpen]);

	// The page-wide cursor and selection lock belong to an effect so React
	// guarantees the undo. Applied imperatively on pointerdown they outlive a
	// drag that ends without a release — leaving the whole app wearing a
	// col-resize cursor with no text selectable, permanently.
	useEffect(() => {
		if (!isDragging) return;

		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		return () => {
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};
	}, [isDragging]);

	// Pointer events rather than mouse events, and pointer capture rather than
	// document-level listeners: the drag then follows a finger or a stylus as
	// well as a mouse, and the browser routes every move and the release back to
	// the handle even when the pointer outruns it.
	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		setIsDragging(true);
	}, []);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!isDragging) return;
			setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX)));
		},
		[isDragging],
	);

	// Also the pointercancel handler: the gesture can be taken away mid-drag (the
	// browser claiming it for a scroll), and the width reached by then is the one
	// the user last saw.
	const handlePointerEnd = useCallback(() => {
		if (!isDragging) return;
		setIsDragging(false);
		localStorage.setItem(SIDEBAR_WIDTH_KEY, width.toString());
	}, [isDragging, width]);

	// The keyboard path to the same preference, after the WAI-ARIA window
	// splitter: arrows step, Home and End go to the limits. Every press is
	// final, so it is stored at once — there is no release to wait for.
	// A chord is left alone: Alt+← is the browser's Back, and taking it here
	// would strand a user whose focus happens to rest on the handle.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.altKey || e.ctrlKey || e.metaKey) return;
			let next: number;
			switch (e.key) {
				case "ArrowLeft":
					next = width - KEYBOARD_STEP;
					break;
				case "ArrowRight":
					next = width + KEYBOARD_STEP;
					break;
				case "Home":
					next = MIN_WIDTH;
					break;
				case "End":
					next = MAX_WIDTH;
					break;
				default:
					return;
			}
			e.preventDefault();
			next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next));
			setWidth(next);
			localStorage.setItem(SIDEBAR_WIDTH_KEY, next.toString());
		},
		[width],
	);

	const columnId = useId();

	// Expanded: a column in the flex layout. Collapsed, it is hidden rather
	// than unmounted, for the same reason the drawer is: the open tab, its
	// scroll position and the file tree's expanded folders are still there
	// when it comes back. The width is left alone, so it comes back as wide.
	if (isExpanded) {
		return (
			// No height of its own: the row gives it, the way the chat panel
			// beside it takes its own. Restating `h-dvh` here made the column
			// outrun a row the shell had already shortened by its banners
			// (docs/responsive-ui.md § Who owns the scroll boundary).
			//
			// outline-none: focused on expand only to announce the region, as
			// the drawer's panel is on open.
			<aside
				ref={columnRef}
				id={columnId}
				aria-label="Sidebar"
				tabIndex={-1}
				className={`relative shrink-0 flex-col border-r border-th-border bg-th-bg-secondary outline-none ${isOpen ? "flex" : "hidden"}`}
				style={{ width }}
			>
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
				{/*
				 * touch-pan-y, not touch-none: the handle claims horizontal drags
				 * only, so it does not become an 8px strip that swallows scrolling.
				 *
				 * Deliberately left at 8px rather than widened to the 44px coarse
				 * floor. Sidebar width is a preference, not an operation (P2 in
				 * docs/responsive-ui.md), and a 44px drag strip would lie over the
				 * right edge of every row in the list — where Delete sits — turning
				 * taps that work today into drags. The floor is there to make
				 * operations reachable, not to make a preference easier at the cost
				 * of one.
				 *
				 * A focusable separator so a screen reader announces it as the
				 * column's adjustable edge and a keyboard can move it. The focus
				 * ring is the accent line hover already uses: an outline around an
				 * 8px strip would sit over the column's own border.
				 */}
				{/* biome-ignore lint/a11y/useSemanticElements: an <hr> is a static rule; a focusable, valued separator is a widget and has no element */}
				<div
					role="separator"
					aria-label="Resize sidebar"
					aria-orientation="vertical"
					aria-controls={columnId}
					aria-valuenow={width}
					aria-valuemin={MIN_WIDTH}
					aria-valuemax={MAX_WIDTH}
					aria-valuetext={`${width} pixels`}
					tabIndex={0}
					onKeyDown={handleKeyDown}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerEnd}
					onPointerCancel={handlePointerEnd}
					className="group absolute top-0 right-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize touch-pan-y outline-none"
				>
					<div
						className={`absolute left-1/2 h-full w-0.5 -translate-x-1/2 transition-colors group-hover:bg-th-accent group-focus-visible:bg-th-accent ${isDragging ? "bg-th-accent" : "bg-transparent"}`}
					/>
				</div>
			</aside>
		);
	}

	// Compact and regular: overlay drawer (use CSS hiding to preserve scroll position)
	//
	// A modal dialog: `AppShell` makes everything behind it `inert` while it is
	// open, so Tab and a screen reader stay inside without a trap of its own.
	// The backdrop is inside the dialog on purpose — it is the one close control
	// the drawer guarantees whatever content it holds, and a touch screen reader
	// has no Escape to reach for.
	return (
		<div
			className={isOpen ? undefined : "hidden"}
			role="dialog"
			aria-modal="true"
			aria-label="Sidebar"
		>
			<button
				type="button"
				className="fixed inset-0 z-40 bg-th-bg-overlay"
				onClick={onClose}
				aria-label="Close sidebar"
			/>

			{/* outline-none: focused on open only to announce the dialog, and a
			    ring around the whole panel would read as a control. */}
			<div
				ref={drawerRef}
				tabIndex={-1}
				className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-th-bg-secondary outline-none"
			>
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
			</div>
		</div>
	);
}

export default Sidebar;
