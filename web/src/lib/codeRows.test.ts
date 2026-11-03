import { describe, expect, it } from "vitest";
import { lineAt, lineBox } from "./codeRows";

/** 3 rows of 19.1875px under 12px of padding, as Chromium draws 12px code. */
function uniformBlock() {
	const pre = document.createElement("pre");
	const code = document.createElement("code");
	pre.append(code);
	// jsdom lays nothing out.
	pre.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
	code.getBoundingClientRect = () =>
		({ top: 112, height: 3 * 19.1875 }) as DOMRect;
	return pre;
}

describe("lineBox, unwrapped", () => {
	it("puts a line its rows down from the first, unrounded", () => {
		const pre = uniformBlock();

		expect(lineBox(pre, 1, 3)).toEqual({ top: 12, height: 19.1875 });
		expect(lineBox(pre, 3, 3)).toEqual({
			top: 12 + 2 * 19.1875,
			height: 19.1875,
		});
	});
});

describe("lineAt", () => {
	it("finds the line drawn at a height, line 1 in the padding above it", () => {
		const pre = uniformBlock();
		expect(lineAt(pre, 0, 3)).toBe(1);
		expect(lineAt(pre, 12 + 19.1875 - 0.01, 3)).toBe(1);
		expect(lineAt(pre, 12 + 19.1875, 3)).toBe(2);
		expect(lineAt(pre, 1000, 3)).toBe(3);
	});
});
