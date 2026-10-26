import { describe, expect, it } from "vitest";
import { readMarkdownFile } from "./frontmatter";

function properties(content: string) {
	const { frontmatter } = readMarkdownFile(content);
	if (frontmatter?.state !== "properties") {
		throw new Error(`expected properties, got ${JSON.stringify(frontmatter)}`);
	}
	return frontmatter.entries;
}

describe("readMarkdownFile", () => {
	it("splits leading frontmatter from the body", () => {
		const { frontmatter, body } = readMarkdownFile(
			"---\nname: commit\n---\n# Title\n",
		);

		expect(frontmatter).toEqual({
			state: "properties",
			entries: [{ key: "name", value: { kind: "text", text: "commit" } }],
		});
		expect(body.trim()).toBe("# Title");
	});

	it.each([
		["no frontmatter", "# Title\n\n---\n\nname: x\n---\n"],
		["a rule that is not at the start", "\n---\nname: x\n---\n"],
		["an opening fence that is never closed", "---\nname: x\n"],
	])("leaves %s to the body", (_, content) => {
		expect(readMarkdownFile(content)).toEqual({ body: content });
	});

	it("finds frontmatter behind a byte order mark", () => {
		expect(readMarkdownFile("\uFEFF---\nname: commit\n---\nbody")).toEqual({
			frontmatter: {
				state: "properties",
				entries: [{ key: "name", value: { kind: "text", text: "commit" } }],
			},
			body: "\nbody",
		});
	});

	it.each([
		["nothing", "---\n---\nbody"],
		["only comments", "---\n# a comment\n---\nbody"],
		["an empty mapping", "---\n{}\n---\nbody"],
	])("has no frontmatter to show when it holds %s", (_, content) => {
		expect(readMarkdownFile(content)).toEqual({ body: "\nbody" });
	});

	it("keeps values as written in the file", () => {
		expect(
			properties(
				"---\nprice: 1.50\nmask: 0x1F\ndraft: false\ndate: 2024-05-01\n10: ten\n---\n",
			),
		).toEqual([
			{ key: "price", value: { kind: "literal", text: "1.50" } },
			{ key: "mask", value: { kind: "literal", text: "0x1F" } },
			{ key: "draft", value: { kind: "literal", text: "false" } },
			{ key: "date", value: { kind: "text", text: "2024-05-01" } },
			{ key: "10", value: { kind: "text", text: "ten" } },
		]);
	});

	it("keeps a block scalar's line breaks without its trailing newline", () => {
		expect(properties("---\nnote: |\n  one\n  two\n---\n")).toEqual([
			{ key: "note", value: { kind: "text", text: "one\ntwo" } },
		]);
	});

	it.each([
		"~",
		"null",
		'""',
		"[]",
		"{}",
		"",
	])("marks %j as empty", (written) => {
		expect(properties(`---\nkey: ${written}\n---\n`)).toEqual([
			{ key: "key", value: { kind: "empty" } },
		]);
	});

	it("draws a list of scalars as chips and anything else as nested blocks", () => {
		expect(
			properties(
				"---\ntags: [review, 2]\nparams:\n  author: me\nitems:\n  - a\n  - b: c\n---\n",
			),
		).toEqual([
			{
				key: "tags",
				value: {
					kind: "chips",
					items: [
						{ kind: "text", text: "review" },
						{ kind: "literal", text: "2" },
					],
				},
			},
			{
				key: "params",
				value: {
					kind: "map",
					entries: [{ key: "author", value: { kind: "text", text: "me" } }],
				},
			},
			{
				key: "items",
				value: {
					kind: "list",
					items: [
						{ kind: "text", text: "a" },
						{
							kind: "map",
							entries: [{ key: "b", value: { kind: "text", text: "c" } }],
						},
					],
				},
			},
		]);
	});

	it("shows a structured value below the third nested level as YAML source", () => {
		const [entry] = properties(
			"---\na:\n  b:\n    c:\n      d:\n        e: 1\n---\n",
		);

		expect(entry).toEqual({
			key: "a",
			value: {
				kind: "map",
				entries: [
					{
						key: "b",
						value: {
							kind: "map",
							entries: [
								{
									key: "c",
									value: {
										kind: "map",
										entries: [
											{ key: "d", value: { kind: "source", text: "e: 1" } },
										],
									},
								},
							],
						},
					},
				],
			},
		});
	});

	it("resolves aliases", () => {
		expect(properties("---\na: &x one\nb: *x\n---\n")).toEqual([
			{ key: "a", value: { kind: "text", text: "one" } },
			{ key: "b", value: { kind: "text", text: "one" } },
		]);
	});

	it.each([
		[
			"broken syntax",
			"name: [unclosed\n",
			/^Flow sequence .* at line \d+, column \d+:$/,
		],
		["duplicate keys", "a: 1\na: 2\n", /^Map keys must be unique/],
	])("reports %s with the raw text", (_, raw, message) => {
		const { frontmatter, body } = readMarkdownFile(`---\n${raw}---\nbody`);

		expect(frontmatter).toMatchObject({
			state: "invalid",
			reason: "syntax",
			raw: raw.trimEnd(),
		});
		const reported =
			frontmatter?.state === "invalid" ? (frontmatter.message ?? "") : "";
		expect(reported).toMatch(message);
		expect(reported).not.toContain("\n");
		expect(body).toBe("\nbody");
	});

	it("reports an error at the file's own line number", () => {
		const { frontmatter } = readMarkdownFile("---\na: 1\nb: [x\n---\n");

		// The opening fence is line 1, so `b: [x` is line 3 of the file.
		expect(frontmatter).toMatchObject({ message: /at line 3, column/ });
	});

	it("reports an alias bomb instead of expanding it", () => {
		const levels = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
		for (let i = 1; i < 9; i++) {
			const alias = `*a${i - 1}`;
			levels.push(`a${i}: &a${i} [${Array(10).fill(alias).join(", ")}]`);
		}

		expect(
			readMarkdownFile(`---\n${levels.join("\n")}\n---\n`).frontmatter,
		).toMatchObject({ state: "invalid", reason: "syntax", message: /alias/i });
	});

	it.each([
		["a scalar", "just text"],
		["a list", "- a\n- b"],
	])("reports frontmatter that is %s as not a set of properties", (_, raw) => {
		expect(readMarkdownFile(`---\n${raw}\n---\n`).frontmatter).toEqual({
			state: "invalid",
			reason: "notMapping",
			raw,
		});
	});
});
