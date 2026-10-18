import { describe, expect, it } from "vitest";
import {
	actualScale,
	bounded,
	fitSize,
	type Layout,
	maxScale,
	pannedBy,
	toggleTarget,
	zoomedTo,
	zoomLabel,
} from "./imageScale";

describe("image scales", () => {
	it("fits a large image inside the frame, keeping its shape", () => {
		expect(
			fitSize({ width: 2000, height: 1000 }, { width: 400, height: 800 }),
		).toEqual({ width: 400, height: 200 });
		expect(
			fitSize({ width: 1000, height: 2000 }, { width: 400, height: 400 }),
		).toEqual({ width: 200, height: 400 });
	});

	it("lays the image out in whole pixels, still inside the frame", () => {
		expect(
			fitSize({ width: 3000, height: 2001 }, { width: 414, height: 800 }),
		).toEqual({ width: 414, height: 276 });
		expect(
			fitSize({ width: 1000, height: 3000 }, { width: 414, height: 800 }),
		).toEqual({ width: 267, height: 800 });
	});

	it("never enlarges a small image", () => {
		expect(
			fitSize({ width: 60, height: 40 }, { width: 400, height: 800 }),
		).toEqual({ width: 60, height: 40 });
	});

	it("has no fit until both sizes are known", () => {
		expect(fitSize(null, { width: 400, height: 800 })).toBeNull();
		expect(fitSize({ width: 60, height: 40 }, { width: 0, height: 0 })).toBe(
			null,
		);
	});

	it("puts actual size at one image pixel per CSS pixel, and the ceiling at four times it", () => {
		const actual = actualScale(
			{ width: 1170, height: 2532 },
			{ width: 375, height: 811.5 },
		);
		expect(actual).toBeCloseTo(3.12, 2);
		expect(maxScale(actual)).toBeCloseTo(12.48, 2);
		// A small image still gets 4×.
		expect(maxScale(1)).toBe(4);
	});

	it("toggles fit to actual size, or to 2× when actual is too close to fit", () => {
		expect(toggleTarget(1, 3)).toBe(3);
		expect(toggleTarget(1.005, 3)).toBe(3);
		expect(toggleTarget(1, 1.2)).toBe(2);
		expect(toggleTarget(2.5, 3)).toBe(1);
	});

	it("reads Fit at fit, otherwise the share of actual size", () => {
		expect(zoomLabel(1, 3)).toBe("Fit");
		expect(zoomLabel(3, 3)).toBe("100%");
		expect(zoomLabel(7.5, 3)).toBe("250%");
	});
});

describe("image transform", () => {
	// A 400×200 frame and an image fitting it at 400×100: at 3× it is
	// 1200×300, larger than the frame on both axes.
	const layout: Layout = {
		frame: { width: 400, height: 200 },
		image: { width: 400, height: 100 },
	};
	const centre = { x: 200, y: 100 };

	it("centres the image on an axis where it is smaller than the frame", () => {
		expect(bounded({ scale: 1, x: -30, y: 70 }, layout)).toEqual({
			scale: 1,
			x: 0,
			y: 50,
		});
		expect(bounded({ scale: 1.5, x: -30, y: 0 }, layout)).toEqual({
			scale: 1.5,
			x: -30,
			y: 25,
		});
	});

	it("leaves no empty edge where the image is larger than the frame", () => {
		expect(bounded({ scale: 3, x: 50, y: 10 }, layout)).toEqual({
			scale: 3,
			x: 0,
			y: 0,
		});
		expect(bounded({ scale: 3, x: -900, y: -150 }, layout)).toEqual({
			scale: 3,
			x: -800,
			y: -100,
		});
	});

	it("zooms about a point, keeping what is under it in place", () => {
		const fit = bounded({ scale: 1, x: 0, y: 0 }, layout);
		const zoomed = zoomedTo(fit, 3, { x: 100, y: 100 }, layout);
		expect(zoomed).toEqual({ scale: 3, x: -200, y: -50 });
		// The image point that was under (100, 100) is under it still.
		expect((100 - fit.x) / fit.scale).toBe((100 - zoomed.x) / zoomed.scale);
	});

	it("zooms about the centre into a corner only as far as the bounds allow", () => {
		expect(
			zoomedTo({ scale: 3, x: -800, y: -100 }, 1.5, centre, layout),
		).toEqual({ scale: 1.5, x: -200, y: 25 });
	});

	it("comes back to fit centred, wherever the image was", () => {
		expect(
			zoomedTo({ scale: 3, x: -800, y: 0 }, 1, { x: 0, y: 0 }, layout),
		).toEqual({ scale: 1, x: 0, y: 50 });
	});

	it("pans until an edge reaches the frame's edge", () => {
		const view = zoomedTo(
			bounded({ scale: 1, x: 0, y: 0 }, layout),
			3,
			centre,
			layout,
		);
		expect(pannedBy(view, -40, 0, layout).x).toBe(view.x - 40);
		expect(pannedBy(view, -1000, 0, layout).x).toBe(-800);
		expect(pannedBy(view, 1000, 0, layout).x).toBe(0);
	});
});
