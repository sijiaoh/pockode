import { describe, expect, it } from "vitest";
import { appendToDraft, insertIntoDraft } from "./draftText";

describe("appendToDraft", () => {
	it("fills a draft with no words in it", () => {
		expect(appendToDraft("", "Explain this")).toBe("Explain this");
		expect(appendToDraft("  \n", "Explain this")).toBe("Explain this");
	});

	it("goes after the user's words, a blank line apart", () => {
		expect(appendToDraft("My question\n\n\n", "Explain this")).toBe(
			"My question\n\nExplain this",
		);
	});

	it("adds nothing the draft already holds", () => {
		const draft = "My question\n\nExplain this";
		expect(appendToDraft(draft, "Explain this\n")).toBe(draft);
	});
});

describe("insertIntoDraft", () => {
	const block = "```diff\n+edit\n```";

	it("fills a draft with no words, leaving the caret on a line under it", () => {
		expect(insertIntoDraft(" \n", block, 1)).toEqual({
			draft: `${block}\n\n`,
			caret: block.length + 2,
		});
	});

	it("goes in at the caret, a blank line apart from the words around it", () => {
		const { draft, caret } = insertIntoDraft("Fix this and that", block, 9);
		expect(draft).toBe(`Fix this\n\n${block}\n\nand that`);
		expect(draft.slice(caret)).toBe("\nand that");
	});

	it("goes after the words a caret at their end follows", () => {
		const { draft, caret } = insertIntoDraft("Mine", block, 4);
		expect(draft).toBe(`Mine\n\n${block}\n\n`);
		expect(caret).toBe(draft.length);
	});

	it("keeps the indent of the line after the caret", () => {
		expect(insertIntoDraft("Context:\n    const x = 1", block, 8).draft).toBe(
			`Context:\n\n${block}\n\n    const x = 1`,
		);
	});

	// A block in a block would split the first one's fence.
	it("goes past the end of a fenced block the caret is inside", () => {
		const earlier = "```diff\n+old\n```";
		const draft = `Fix\n\n${earlier}\n\nand`;
		expect(insertIntoDraft(draft, block, draft.indexOf("+old")).draft).toBe(
			`Fix\n\n${earlier}\n\n${block}\n\nand`,
		);
	});

	// A block in a block would split the first one's fence.
	it("goes past the end of a fenced block the caret is inside", () => {
		const earlier = "```diff\n+old\n```";
		const draft = `Fix\n\n${earlier}\n\nand`;
		expect(insertIntoDraft(draft, block, draft.indexOf("+old")).draft).toBe(
			`Fix\n\n${earlier}\n\n${block}\n\nand`,
		);
	});

	it("adds nothing the draft already holds, and leaves the caret be", () => {
		const held = `Mine\n\n${block}\n\nmore`;
		expect(insertIntoDraft(held, block, 2)).toEqual({ draft: held, caret: 2 });
	});
});
