import { useCallback, useEffect, useRef, useState } from "react";

// One arrow press moves the edge by a step a sighted user can see land: the
// sidebar's 240..500 is then about sixteen presses across.
const KEYBOARD_STEP = 16;

interface Options {
	/** localStorage key the width the user chose is kept under. */
	storageKey: string;
	min: number;
	/**
	 * May follow the container. It only bounds what is drawn: a stored width
	 * above it is kept, and comes back once there is room for it again.
	 */
	max: number;
	/** Drawn until the user picks a width, and again after `reset`. */
	defaultWidth: number;
	/**
	 * Whether the handle is on screen. Taking it away mid-drag ends the drag:
	 * the handle is gone before any pointerup or pointercancel can reach it,
	 * and without this the drag would stay live forever.
	 */
	active: boolean;
}

export interface ResizableWidth {
	width: number;
	min: number;
	max: number;
	isDragging: boolean;
	/** Back to the default, which then follows `defaultWidth` again. */
	reset: () => void;
	handlers: {
		onKeyDown: (e: React.KeyboardEvent) => void;
		onPointerDown: (e: React.PointerEvent) => void;
		onPointerMove: (e: React.PointerEvent) => void;
		onPointerUp: () => void;
		onPointerCancel: () => void;
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function readStored(key: string, min: number): number | null {
	const saved = localStorage.getItem(key);
	if (!saved) return null;
	const parsed = Number.parseInt(saved, 10);
	return Number.isNaN(parsed) || parsed < min ? null : parsed;
}

/**
 * Drag-to-resize for a column whose right edge is the handle, kept as a
 * per-key preference. Pair it with `ResizeHandle`.
 */
export function useResizableWidth({
	storageKey,
	min,
	max: requestedMax,
	defaultWidth,
	active,
}: Options): ResizableWidth {
	// A container too narrow for both limits keeps the minimum: the column
	// below it is unusable, while the space beside it only gets tighter.
	const max = Math.max(min, requestedMax);

	// null while the user has not chosen, so a default relative to the
	// container keeps following it.
	const [preferred, setPreferred] = useState(() => readStored(storageKey, min));
	const width = clamp(preferred ?? defaultWidth, min, max);

	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef({ x: 0, width: 0, moved: false });

	useEffect(() => {
		if (!active) setIsDragging(false);
	}, [active]);

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
	//
	// The width follows the pointer's travel rather than its position, so the
	// column need not start at the viewport's left edge, and grabbing the
	// handle off its centre line does not make the edge jump.
	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			e.currentTarget.setPointerCapture(e.pointerId);
			dragRef.current = { x: e.clientX, width, moved: false };
			setIsDragging(true);
		},
		[width],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!isDragging) return;
			const start = dragRef.current;
			if (!start.moved && e.clientX === start.x) return;
			start.moved = true;
			setPreferred(clamp(start.width + e.clientX - start.x, min, max));
		},
		[isDragging, min, max],
	);

	// Also the pointercancel handler: the gesture can be taken away mid-drag (the
	// browser claiming it for a scroll), and the width reached by then is the one
	// the user last saw. A press that never moved chose nothing — the clicks
	// of a double-click among them — so a default relative to the container
	// is not frozen into a stored width by it.
	const onPointerEnd = useCallback(() => {
		if (!isDragging) return;
		setIsDragging(false);
		if (dragRef.current.moved) {
			localStorage.setItem(storageKey, width.toString());
		}
	}, [isDragging, storageKey, width]);

	// The keyboard path to the same preference, after the WAI-ARIA window
	// splitter: arrows step, Home and End go to the limits. Every press is
	// final, so it is stored at once — there is no release to wait for.
	// A chord is left alone: Alt+← is the browser's Back, and taking it here
	// would strand a user whose focus happens to rest on the handle.
	const onKeyDown = useCallback(
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
					next = min;
					break;
				case "End":
					next = max;
					break;
				default:
					return;
			}
			e.preventDefault();
			next = clamp(next, min, max);
			setPreferred(next);
			localStorage.setItem(storageKey, next.toString());
		},
		[width, min, max, storageKey],
	);

	const reset = useCallback(() => {
		setPreferred(null);
		localStorage.removeItem(storageKey);
	}, [storageKey]);

	return {
		width,
		min,
		max,
		isDragging,
		reset,
		handlers: {
			onKeyDown,
			onPointerDown,
			onPointerMove,
			onPointerUp: onPointerEnd,
			onPointerCancel: onPointerEnd,
		},
	};
}
