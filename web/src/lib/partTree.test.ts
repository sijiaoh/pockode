import { describe, expect, it } from "vitest";
import type { ContentPart } from "../types/message";
import { partBlocks } from "./partTree";

const text = (content: string) => ({ type: "text", content }) as ContentPart;
const tool = (id: string) =>
	({ type: "tool_call", tool: { id, name: "Bash", input: {} } }) as ContentPart;
const card = (requestId: string) =>
	({
		type: "permission_request",
		request: { requestId },
		status: "pending",
	}) as ContentPart;
const question = (requestId: string) =>
	({ type: "question_record", record: { requestId } }) as ContentPart;

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

	it("leaves a question card out of the list, splitting it", () => {
		expect(shape([tool("1"), question("q"), tool("2")])).toEqual([
			1,
			"question_record",
			1,
		]);
	});
});
