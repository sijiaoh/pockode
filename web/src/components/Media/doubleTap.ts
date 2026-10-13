import type { PointerEvent } from "react";

/**
 * Users' double-taps land up to about 300 ms apart — the library's own 200 ms
 * window misses many of them.
 */
const TAP_WINDOW_MS = 300;

/** How far a finger may drift and still have tapped, and the two taps be one place. */
const TAP_SLOP_PX = 24;

interface Point {
	x: number;
	y: number;
}

function near(a: Point, b: Point): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= TAP_SLOP_PX;
}

/**
 * Recognises a touch double-tap from pointer events: two taps of one finger,
 * close in time and place, with no pan or pinch in between. Pointer events
 * rather than `dblclick`, which browsers do not reliably fire for touch under
 * `touch-action: none`. Mouse pointers are ignored; `dblclick` serves them.
 */
export class DoubleTapTracker {
	private down = new Map<number, Point>();
	private pinched = false;
	private lastTap: (Point & { time: number }) | null = null;

	private onDoubleTap: (clientX: number, clientY: number) => void;

	constructor(onDoubleTap: (clientX: number, clientY: number) => void) {
		this.onDoubleTap = onDoubleTap;
	}

	pointerDown = (event: PointerEvent) => {
		if (event.pointerType === "mouse") return;
		this.down.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (this.down.size > 1) {
			this.pinched = true;
			this.lastTap = null;
		}
	};

	pointerUp = (event: PointerEvent) => {
		const start = this.down.get(event.pointerId);
		if (!start) return;
		this.down.delete(event.pointerId);
		const pinched = this.pinched;
		if (this.down.size === 0) this.pinched = false;

		const point = { x: event.clientX, y: event.clientY };
		if (pinched || !near(start, point)) {
			this.lastTap = null;
			return;
		}
		const last = this.lastTap;
		if (
			last &&
			event.timeStamp - last.time <= TAP_WINDOW_MS &&
			near(last, point)
		) {
			this.lastTap = null;
			this.onDoubleTap(point.x, point.y);
			return;
		}
		this.lastTap = { ...point, time: event.timeStamp };
	};

	pointerCancel = (event: PointerEvent) => {
		this.down.delete(event.pointerId);
		if (this.down.size === 0) this.pinched = false;
		this.lastTap = null;
	};
}
