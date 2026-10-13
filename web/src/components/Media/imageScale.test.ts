import { describe, expect, it } from "vitest";
import {
	actualScale,
	fitSize,
	maxScale,
	toggleTarget,
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
