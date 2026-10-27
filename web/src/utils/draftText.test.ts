import { describe, expect, it } from "vitest";
import { appendToDraft } from "./draftText";

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
