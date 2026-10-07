import { describe, expect, it } from "vitest";
import { parseOutput } from "./FullScreenLines";

const ESC = String.fromCharCode(27);

describe("parseOutput", () => {
	it("carries a colour left on into the lines after it", () => {
		const { html } = parseOutput(`${ESC}[31mred\nstill red${ESC}[0m\nplain`);
		expect(html[1]).toContain("ansi-red-fg");
		expect(html[2]).not.toContain("ansi-red");
	});

	it("does not leak colour from one output into the next", () => {
		parseOutput(`${ESC}[31mleft on`);
		expect(parseOutput("fresh").html[0]).toBe("fresh");
	});

	it("reads as the text drawn, escapes undone and sequences dropped", () => {
		const link = `${ESC}]8;;https://example.com${ESC}\\site${ESC}]8;;${ESC}\\`;
		const { text } = parseOutput(`a < b & "c"\n${link}\n${ESC}[1mbold`);
		expect(text).toEqual(['a < b & "c"', "site", "bold"]);
	});

	it("ends a sequence the output broke off at its line, as the whole text does", () => {
		const { text } = parseOutput(
			`a${ESC}]8;;http://x.com\nline2\nline3\nfoo${ESC}[3\nbar`,
		);
		expect(text.slice(1, 3)).toEqual(["line2", "line3"]);
		expect(text.at(-1)).toBe("bar");
	});
});
