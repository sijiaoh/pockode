import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { frontmatter } from "micromark-extension-frontmatter";
import {
	type Document,
	isAlias,
	isMap,
	isScalar,
	isSeq,
	type Node,
	parseDocument,
	Scalar,
	stringify,
} from "yaml";

/**
 * A frontmatter value as it is drawn. Everything here is plain text: values
 * are file metadata, never Markdown or HTML.
 */
export type FrontmatterValue =
	| { kind: "text"; text: string }
	/** A number or boolean, as written in the file (`1.50` stays `1.50`). */
	| { kind: "literal"; text: string }
	/** `null`, `~`, `""`, `[]` or `{}`. */
	| { kind: "empty" }
	/** A list whose items are all scalars. */
	| { kind: "chips"; items: FrontmatterScalar[] }
	| { kind: "map"; entries: FrontmatterEntry[] }
	/** A list with at least one structured item. */
	| { kind: "list"; items: FrontmatterValue[] }
	/** A structured value nested too deep to draw as blocks. */
	| { kind: "source"; text: string };

export type FrontmatterScalar = Extract<
	FrontmatterValue,
	{ kind: "text" | "literal" | "empty" }
>;

export interface FrontmatterEntry {
	key: string;
	value: FrontmatterValue;
}

export type Frontmatter =
	| { state: "properties"; entries: FrontmatterEntry[] }
	| {
			state: "invalid";
			reason: "syntax" | "notMapping";
			/** The first line of the parser's message; absent for `notMapping`. */
			message?: string;
			/** The text between the fences. */
			raw: string;
	  };

export interface MarkdownFile {
	/** Absent when the file has none, or one with nothing in it. */
	frontmatter?: Frontmatter;
	body: string;
}

/** Structured values deeper than this are shown as YAML source. */
const MAX_DEPTH = 3;

/**
 * Splits a Markdown file into its leading YAML frontmatter and its body.
 * Frontmatter is a file convention, not Markdown, so this is for file views
 * only — chat and work bodies keep a leading `---` as a rule.
 */
export function readMarkdownFile(file: string): MarkdownFile {
	// micromark drops a byte order mark before it parses, so its offsets are
	// into the text without one.
	const content = file.startsWith("\uFEFF") ? file.slice(1) : file;
	// micromark recognises frontmatter only at the very start; skip the parse
	// for the files that cannot have it.
	if (!content.startsWith("---")) return { body: file };

	const tree = fromMarkdown(content, {
		extensions: [frontmatter("yaml")],
		mdastExtensions: [frontmatterFromMarkdown("yaml")],
	});
	const first = tree.children[0];
	const end = first?.position?.end.offset;
	if (first?.type !== "yaml" || end === undefined) return { body: file };

	return {
		frontmatter: parseFrontmatter(first.value),
		body: content.slice(end),
	};
}

function parseFrontmatter(raw: string): Frontmatter | undefined {
	const invalid = (
		reason: "syntax" | "notMapping",
		error?: Error,
	): Frontmatter => ({
		state: "invalid",
		reason,
		// The rest is a multi-line code frame; the first line already names
		// the line and column.
		message: error?.message.split("\n")[0],
		raw: raw.replace(/\n+$/, ""),
	});

	// The opening fence is line 1 of the file: parsing from a line before the
	// frontmatter makes the line numbers in an error the file's own.
	const source = `\n${raw}`;
	// The core schema keeps `2024-05-01` a string, shown as written rather
	// than as a reformatted date.
	const doc = parseDocument(source, { schema: "core" });
	const [error] = doc.errors;
	if (error) return invalid("syntax", error);
	try {
		// Aliases are expanded below; this is the parser's own guard against
		// an alias bomb, which would otherwise throw while drawing. `mapAsMap`
		// keeps a collection key (`? [a, b]`) from logging a warning.
		doc.toJS({ mapAsMap: true });
	} catch (error) {
		return invalid("syntax", error instanceof Error ? error : undefined);
	}

	const contents = resolve(doc, doc.contents);
	if (contents === null || (isScalar(contents) && contents.value === null)) {
		return undefined;
	}
	if (!isMap(contents)) return invalid("notMapping");
	if (contents.items.length === 0) return undefined;
	return { state: "properties", entries: toEntries(doc, source, contents, 1) };
}

function resolve(doc: Document, node: unknown): Node | null {
	if (isAlias(node)) return resolve(doc, node.resolve(doc) ?? null);
	return (node as Node | null) ?? null;
}

function toEntries(
	doc: Document,
	source: string,
	map: { items: { key: unknown; value: unknown }[] },
	depth: number,
): FrontmatterEntry[] {
	return map.items.map((pair) => ({
		key: keyText(doc, source, pair.key),
		value: toValue(doc, source, pair.value, depth),
	}));
}

function keyText(doc: Document, source: string, node: unknown): string {
	const key = resolve(doc, node);
	if (key === null) return "";
	if (isScalar(key)) return scalarText(source, key);
	return stringify(key.toJS(doc)).trimEnd();
}

function toValue(
	doc: Document,
	source: string,
	node: unknown,
	depth: number,
): FrontmatterValue {
	const value = resolve(doc, node);
	if (value === null) return { kind: "empty" };
	if (isScalar(value)) return toScalar(source, value);
	if (!isMap(value) && !isSeq(value)) return { kind: "empty" };
	if (value.items.length === 0) return { kind: "empty" };
	if (depth > MAX_DEPTH) {
		return { kind: "source", text: stringify(value.toJS(doc)).trimEnd() };
	}
	if (isMap(value)) {
		return { kind: "map", entries: toEntries(doc, source, value, depth + 1) };
	}

	const items = value.items.map((item) => resolve(doc, item));
	if (items.every((item) => item === null || isScalar(item))) {
		return {
			kind: "chips",
			items: items.map((item) =>
				item === null ? { kind: "empty" } : toScalar(source, item as Scalar),
			),
		};
	}
	return {
		kind: "list",
		items: items.map((item) => toValue(doc, source, item, depth + 1)),
	};
}

function toScalar(source: string, node: Scalar): FrontmatterScalar {
	const { value } = node;
	if (value === null || value === "") return { kind: "empty" };
	if (typeof value === "string") {
		const block =
			node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED;
		return { kind: "text", text: block ? value.replace(/\n+$/, "") : value };
	}
	return { kind: "literal", text: scalarText(source, node) };
}

/** A scalar as written: `String(value)` would turn `0x1F` into `31`. */
function scalarText(source: string, node: Scalar): string {
	if (typeof node.value === "string") return node.value;
	return node.range
		? source.slice(node.range[0], node.range[1])
		: String(node.value);
}
