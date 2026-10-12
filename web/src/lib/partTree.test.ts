import { describe, expect, it } from "vitest";
import type { ContentPart } from "../types/message";
import { newPartId, oldestPart, partBlocks } from "./partTree";

const text = (content: string): ContentPart => ({
	id: newPartId(),
	type: "text",
	content,
});
const tool = (id: string) =>
	({
		id: newPartId(),
		type: "tool_call",
		tool: { id, name: "Bash", input: {} },
	}) as ContentPart;
const card = (requestId: string) =>
	({
		id: newPartId(),
		type: "permission_request",
		request: { requestId },
		status: "pending",
	}) as ContentPart;
const question = (requestId: string) =>
	({
		id: newPartId(),
		type: "question_record",
		record: { requestId },
	}) as ContentPart;

function shape(parts: ContentPart[]) {
	return partBlocks(parts.map((part) => ({ part }))).map((block) =>
		block.kind === "rows" ? block.items.length : block.item.part.type,
	);
}

describe("partBlocks", () => {
	it("puts each run of rows, cards included, in one list", () => {
		expect(
			shape([text("a"), tool("1"), card("p"), tool("2"), text("b"), tool("3")]),
		).toEqual(["text", 3, "text", 1]);
	});

	// The page is the reply, not a line in the tool log.
	it("leaves a successful html_render call out of the list, splitting it", () => {
		const page = {
			type: "tool_call",
			tool: { id: "p", name: "pockode:html_render", status: "success" },
		} as ContentPart;
		expect(shape([tool("1"), page, tool("2")])).toEqual([1, "tool_call", 1]);
	});

	it("leaves a question card out of the list, splitting it", () => {
		expect(shape([tool("1"), question("q"), tool("2")])).toEqual([
			1,
			"question_record",
			1,
		]);
	});
});

describe("part identity", () => {
	// The comparison is a string comparison, so it has to hold across a carry
	// into the next base-36 digit — which any 100 ids in a row include.
	it("mints ids that sort in the order they were minted", () => {
		const ids = Array.from({ length: 100 }, newPartId);
		expect([...ids].sort()).toEqual(ids);
	});

	// A list is named after it, so neither end it grows at may displace it: a
	// page joining in front, nor a part arriving after.
	it("finds the part that has been there longest, wherever it sits", () => {
		const shown = [text("a"), text("b")].map((part) => ({ part }));
		const first = oldestPart(shown);
		const grown = [{ part: text("older") }, ...shown, { part: text("newer") }];
		expect(oldestPart(grown)).toBe(first);
		expect(first.part).toMatchObject({ content: "a" });
	});
});
