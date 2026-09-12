import { useCallback, useEffect, useState } from "react";

const SIDEBAR_WIDTH_KEY = "pockode:sidebar-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 500;
const DEFAULT_WIDTH = 288; // w-72

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
	isOpen: boolean;
	onClose: () => void;
	children: React.ReactNode;
	isExpanded: boolean;
}

function Sidebar({ isOpen, onClose, children, isExpanded }: Props) {
	const [width, setWidth] = useState(getInitialWidth);
	const [isDragging, setIsDragging] = useState(false);

	// Escape closes the drawer; in the expanded tier the column is not dismissable.
	useEffect(() => {
		if (isExpanded) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isOpen) {
				onClose();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, onClose, isExpanded]);

	// The handle exists only in the expanded tier, so a viewport shrinking out of
	// it takes the drag with it: the element is gone before any pointerup or
	// pointercancel can reach it, and without this the drag stays live forever.
	useEffect(() => {
		if (!isExpanded) setIsDragging(false);
	}, [isExpanded]);

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

	// Expanded: a persistent column in the flex layout
	if (isExpanded) {
		return (
			<div
				className="relative flex h-dvh shrink-0 flex-col border-r border-th-border bg-th-bg-secondary"
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
				 */}
				<div
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerEnd}
					onPointerCancel={handlePointerEnd}
					className="group absolute top-0 right-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize touch-pan-y"
				>
					<div
						className={`absolute left-1/2 h-full w-0.5 -translate-x-1/2 transition-colors group-hover:bg-th-accent ${isDragging ? "bg-th-accent" : "bg-transparent"}`}
					/>
				</div>
			</div>
		);
	}

	// Compact and regular: overlay drawer (use CSS hiding to preserve scroll position)
	return (
		<div className={isOpen ? undefined : "hidden"}>
			<button
				type="button"
				className="fixed inset-0 z-40 bg-th-bg-overlay"
				onClick={onClose}
				aria-label="Close sidebar"
			/>

			<div className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-th-bg-secondary">
				<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
			</div>
		</div>
	);
}

export default Sidebar;
