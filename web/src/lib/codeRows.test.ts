import { describe, expect, it } from "vitest";
import { lineTop, measureCodeRows } from "./codeRows";

describe("code rows", () => {
	it("puts a line its rows down from the first, unrounded", () => {
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		pre.append(code);
		// jsdom lays nothing out: 3 rows of 19.1875px under 12px of padding, as
		// Chromium draws 12px code.
		pre.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
		code.getBoundingClientRect = () =>
			({ top: 112, height: 3 * 19.1875 }) as DOMRect;

		const rows = measureCodeRows(pre, 3);

		expect(rows).toEqual({ top: 12, height: 19.1875 });
		expect(lineTop(rows, 1)).toBe(12);
		expect(lineTop(rows, 3)).toBe(12 + 2 * 19.1875);
	});
});
