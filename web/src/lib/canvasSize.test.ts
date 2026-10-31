import { describe, expect, it } from "vitest";
import {
	canvasSizeOf,
	isEditableElement,
	keepsMeasurement,
} from "./canvasSize";

describe("canvasSizeOf", () => {
	it("takes whole pixels, rounded down", () => {
		expect(canvasSizeOf({ width: 390.9, height: 600.5 })).toEqual({
			width: 390,
			height: 600,
		});
	});

	it("has nothing to say for a box with no area", () => {
		expect(canvasSizeOf({ width: 0, height: 600 })).toBeNull();
	});
});

describe("keepsMeasurement", () => {
	const kept = { width: 390, height: 700 };

	it("keeps a height change only while nothing editable has focus", () => {
		const keyboard = { width: 390, height: 400 };
		expect(keepsMeasurement(kept, keyboard, false)).toBe(true);
		expect(keepsMeasurement(kept, keyboard, true)).toBe(false);
	});

	it("always keeps a width change", () => {
		expect(keepsMeasurement(kept, { width: 844, height: 300 }, true)).toBe(
			true,
		);
	});

	it("keeps the first measurement whatever has focus", () => {
		expect(keepsMeasurement(null, kept, true)).toBe(true);
	});
});

describe("isEditableElement", () => {
	const make = (html: string) => {
		const host = document.createElement("div");
		host.innerHTML = html;
		return host.firstElementChild;
	};

	it("counts the fields a keyboard comes up for", () => {
		expect(isEditableElement(make("<input>"))).toBe(true);
		expect(isEditableElement(make('<input type="search">'))).toBe(true);
		expect(isEditableElement(make("<textarea></textarea>"))).toBe(true);
		expect(isEditableElement(make("<select></select>"))).toBe(true);
	});

	it("does not count controls that hold no text, or fields that take none", () => {
		expect(isEditableElement(make('<input type="checkbox">'))).toBe(false);
		expect(isEditableElement(make("<input disabled>"))).toBe(false);
		expect(isEditableElement(make("<textarea readonly></textarea>"))).toBe(
			false,
		);
		expect(isEditableElement(make("<button></button>"))).toBe(false);
		expect(isEditableElement(null)).toBe(false);
	});
});
