import type { PointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { DoubleTapTracker } from "./doubleTap";

function pointer(
	pointerId: number,
	clientX: number,
	clientY: number,
	timeStamp: number,
	pointerType = "touch",
): PointerEvent {
	return {
		pointerId,
		clientX,
		clientY,
		timeStamp,
		pointerType,
	} as PointerEvent;
}

function tap(tracker: DoubleTapTracker, x: number, y: number, at: number) {
	tracker.pointerDown(pointer(1, x, y, at));
	tracker.pointerUp(pointer(1, x, y, at + 50));
}

describe("DoubleTapTracker", () => {
	it("reports two quick taps in one place, at the second", () => {
		const onDoubleTap = vi.fn();
		const tracker = new DoubleTapTracker(onDoubleTap);
		tap(tracker, 100, 100, 0);
		tap(tracker, 110, 105, 250);
		expect(onDoubleTap).toHaveBeenCalledExactlyOnceWith(110, 105);
	});

	it("ignores taps too far apart in time or place", () => {
		const onDoubleTap = vi.fn();
		const tracker = new DoubleTapTracker(onDoubleTap);
		tap(tracker, 100, 100, 0);
		tap(tracker, 100, 100, 500);
		tap(tracker, 200, 100, 600);
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it("does not count a pan or a pinch as a tap", () => {
		const onDoubleTap = vi.fn();
		const tracker = new DoubleTapTracker(onDoubleTap);

		tracker.pointerDown(pointer(1, 100, 100, 0));
		tracker.pointerUp(pointer(1, 160, 100, 100));
		tap(tracker, 160, 100, 200);
		expect(onDoubleTap).not.toHaveBeenCalled();

		tracker.pointerDown(pointer(1, 100, 100, 1000));
		tracker.pointerDown(pointer(2, 150, 100, 1010));
		tracker.pointerUp(pointer(2, 150, 100, 1050));
		tracker.pointerUp(pointer(1, 100, 100, 1060));
		tap(tracker, 100, 100, 1200);
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it("leaves the mouse to dblclick", () => {
		const onDoubleTap = vi.fn();
		const tracker = new DoubleTapTracker(onDoubleTap);
		for (const at of [0, 200]) {
			tracker.pointerDown(pointer(1, 100, 100, at, "mouse"));
			tracker.pointerUp(pointer(1, 100, 100, at + 50, "mouse"));
		}
		expect(onDoubleTap).not.toHaveBeenCalled();
	});
});
