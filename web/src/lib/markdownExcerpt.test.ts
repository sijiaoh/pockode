import { describe, expect, it } from "vitest";
import { markdownExcerpt } from "./markdownExcerpt";

describe("markdownExcerpt", () => {
	it("takes the first line that has words on it", () => {
		expect(markdownExcerpt("\n\n  Plans the story.\nSecond line")).toBe(
			"Plans the story.",
		);
	});

	it("drops block markers", () => {
		expect(markdownExcerpt("# You are the PM ##")).toBe("You are the PM");
		expect(markdownExcerpt("> > quoted")).toBe("quoted");
		expect(markdownExcerpt("- first item")).toBe("first item");
		expect(markdownExcerpt("2. second item")).toBe("second item");
		expect(markdownExcerpt("- [x] done")).toBe("done");
	});

	it("drops inline marks but keeps the words they wrap", () => {
		expect(
			markdownExcerpt("Read **the** _brief_ in `docs/` and [this](https://x)"),
		).toBe("Read the brief in docs/ and this");
		expect(markdownExcerpt("![logo](a.png) ~~old~~ new")).toBe("logo old new");
	});

	it("leaves underscores inside words alone", () => {
		expect(markdownExcerpt("Call task_create for each task")).toBe(
			"Call task_create for each task",
		);
	});

	it("skips lines that are only syntax", () => {
		expect(markdownExcerpt("---\n```ts\nconst a = 1;")).toBe("const a = 1;");
		expect(markdownExcerpt("#\n- \nWords")).toBe("Words");
	});

	it("is empty for a document with no words", () => {
		expect(markdownExcerpt("")).toBe("");
		expect(markdownExcerpt("  \n***\n")).toBe("");
	});
});
