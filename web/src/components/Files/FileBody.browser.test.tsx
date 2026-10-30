import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
	lineTop,
	measureCodeRows,
	NUMBERED_CODE_SELECTOR,
} from "../../lib/codeRows";
import { fileLineCount } from "../../lib/textLines";
import FileBody from "./FileBody";

// What jsdom cannot say: that the numbers sit on the code's rows to the last
// one, stay pinned while the code scrolls sideways, and never reach a copy.

const LONG = `const long = "${"x".repeat(300)}";`;

/** Every shape that could make a row taller or shorter than the others. */
function fixture(lines = 400): string {
	const shapes = [
		"function f() {",
		"\tconst tab = 1;",
		"\t\t// 二重のタブと日本語",
		"",
		"const emoji = '🙂👍🏽';",
		LONG,
		"}",
	];
	return `${Array.from({ length: lines }, (_, i) => shapes[i % shapes.length]).join("\n")}\n`;
}

function renderFile(content: string, highlight: boolean) {
	render(
		<div
			data-testid="scroller"
			className="overflow-auto"
			style={{ width: 320, height: 480 }}
		>
			<FileBody
				state={{ kind: "text", content, highlight }}
				path="a.ts"
				lineNumbers
			/>
		</div>,
	);
	const scroller = screen.getByTestId("scroller");
	const pre = scroller.querySelector<HTMLElement>(NUMBERED_CODE_SELECTOR);
	const gutter = scroller.querySelector<HTMLElement>(".code-gutter");
	if (!pre || !gutter) throw new Error("no numbered block");
	return { scroller, pre, gutter };
}

async function highlighted(pre: HTMLElement) {
	await expect.poll(() => pre.querySelector(".shiki .line")).toBeTruthy();
}

/** The height of the rows the code draws, not of the box around it. */
function rowsHeight(pre: HTMLElement): number {
	const code = pre.querySelector("code");
	if (!code) throw new Error("no <code>");
	return code.getBoundingClientRect().height;
}

/**
 * The height of the numbers the gutter draws. Not the gutter's own: the two
 * columns are stretched to the taller one, so their boxes always agree.
 */
function numbersHeight(gutter: HTMLElement): number {
	const first = gutter.firstElementChild;
	const last = gutter.lastElementChild;
	if (!first || !last) throw new Error("an empty gutter");
	return (
		last.getBoundingClientRect().bottom - first.getBoundingClientRect().top
	);
}

/** The vertical middle of where the text of `line` (1-based) is drawn. */
function textMiddle(pre: HTMLElement, content: string, line: number): number {
	const offset = content
		.split("\n")
		.slice(0, line - 1)
		.join("\n").length;
	const at = line === 1 ? 0 : offset + 1;
	const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
	let seen = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const length = node.textContent?.length ?? 0;
		if (seen + length > at) {
			const range = document.createRange();
			range.setStart(node, at - seen);
			range.setEnd(node, at - seen + 1);
			const rect = range.getBoundingClientRect();
			return rect.top + rect.height / 2;
		}
		seen += length;
	}
	throw new Error(`line ${line} not found`);
}

describe.each([
	["highlighted", true],
	["plain", false],
])("a numbered %s file", (_, highlight) => {
	const content = fixture();

	async function view() {
		const rendered = renderFile(content, highlight);
		if (highlight) await highlighted(rendered.pre);
		return rendered;
	}

	it("draws as many numbers as the code draws rows", async () => {
		const { pre, gutter } = await view();

		expect(numbersHeight(gutter)).toBeCloseTo(rowsHeight(pre), 1);
	});

	it("draws each line where `lineTop` says it is", async () => {
		const { pre } = await view();
		const count = fileLineCount(content);
		const rows = measureCodeRows(pre, count);
		const preTop = pre.getBoundingClientRect().top;

		// Lines with text to measure (a blank one has none), spread down the
		// file and after every shape; a miscount puts the last ones a row off.
		for (const line of [1, 2, 3, 5, 6, 7, 201, count - 1, count]) {
			expect(
				Math.abs(
					textMiddle(pre, content, line) -
						(preTop + lineTop(rows, line) + rows.height / 2),
				),
			).toBeLessThan(1);
		}
	});

	it.each([
		["blank lines at the end", "a\n\n\n"],
		["CRLF", "a\r\n\r\nb\r\n"],
		["no final newline", "a\nb"],
	])("counts the rows of a file with %s", async (_, ending) => {
		const { pre, gutter } = renderFile(ending, highlight);
		if (highlight) await highlighted(pre);

		expect(numbersHeight(gutter)).toBeCloseTo(rowsHeight(pre), 1);
	});

	it("keeps the gutter pinned while the code scrolls sideways", async () => {
		const { scroller, gutter } = await view();
		scroller.scrollLeft = 200;
		await expect.poll(() => scroller.scrollLeft).toBe(200);

		expect(gutter.getBoundingClientRect().left).toBeCloseTo(
			scroller.getBoundingClientRect().left,
			1,
		);
	});

	it("copies the code and none of the numbers", async () => {
		const { pre } = await view();
		const block = pre.closest(".code-block-wrapper");
		if (!block) throw new Error("no code block");
		// The whole block, gutter and copy button included; the banner over a
		// plain file is not the block's to copy.
		window.getSelection()?.selectAllChildren(block);
		await userEvent.copy();

		render(<textarea aria-label="paste" />);
		const target = screen.getByLabelText<HTMLTextAreaElement>("paste");
		target.focus();
		await userEvent.paste();

		expect(target.value.replace(/\n$/, "")).toBe(content.replace(/\n$/, ""));
	});
});
