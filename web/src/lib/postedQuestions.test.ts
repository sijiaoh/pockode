import { beforeEach, describe, expect, it } from "vitest";
import {
	msg,
	page,
	question,
	resetItems,
	tool,
	turn,
} from "../test/chatItemsFixture";
import type { PageItem } from "../types/chatItems";
import type { ContentPart, Message } from "../types/message";
import { createChatItems, installNewestPage } from "./chatItems";
import { buildTranscript, createTranscriptCache } from "./transcript";

const POST = "mcp__pockode__question_post";

/** The parts of the reply to a turn holding `items` after its message. */
function replyTo(...items: (() => PageItem)[]): ContentPart[] {
	const store = createChatItems();
	const go = msg("go");
	installNewestPage(
		store,
		page([turn({}, go, ...items.map((build) => build()))]),
		undefined,
		undefined,
	);
	const messages: Message[] = buildTranscript(store, createTranscriptCache(), {
		live: true,
	});
	const last = messages.at(-1);
	return last?.role === "assistant" ? last.parts : [];
}

function labels(parts: ContentPart[]): string[] {
	return parts.map((part) =>
		part.type === "question_record"
			? part.record.requestId
			: part.type === "tool_call"
				? part.tool.name
				: part.type,
	);
}

beforeEach(resetItems);

/**
 * How a posted question is drawn: where its card goes, and the card saying
 * what became of the question as the server states it.
 */
describe("posted questions in the transcript", () => {
	it("draws a question the agent posted", () => {
		expect(
			replyTo(() => question("Which database?", { request_id: "r1" })),
		).toMatchObject([
			{
				type: "question_record",
				status: "pending",
				record: {
					requestId: "r1",
					question: { question: "Which database?" },
				},
			},
		]);
	});

	describe("taking the question_post tool row's place", () => {
		// Joined by position, because there is no `tool_use_id` to join on: the
		// call reaches the server over HTTP from the MCP endpoint. What the
		// server does guarantee is that the question is written *during* the
		// call.
		it("takes the place of the call it was posted during", () => {
			const parts = replyTo(
				() => tool(POST, {}, { result: { text: "posted", seq: 100 } }),
				() => question("Which?", { request_id: "r1" }),
			);
			expect(parts).toMatchObject([
				{ type: "question_record", record: { requestId: "r1" } },
			]);
		});

		it("takes only its own call, not an unrelated one beside it", () => {
			expect(
				labels(
					replyTo(
						() => tool("Read"),
						() => question("Which?", { request_id: "r1" }),
					),
				),
			).toEqual(["Read", "r1"]);
		});

		// A join that misses leaves two rows rather than getting one wrong.
		it("leaves a call that had returned before the question alone", () => {
			expect(
				labels(
					replyTo(
						() => tool(POST, {}, { result: { text: "posted", seq: 2 } }),
						() => question("Which?", { request_id: "r1" }),
					),
				),
			).toEqual([POST, "r1"]);
		});
	});

	// One `question_post` call posts its questions one item each, all with
	// the call's `asked_at`, back to back. Only the first finds the row.
	describe("questions asked in one call", () => {
		const batched = (requestId: string, askedAt: string) => () =>
			question(requestId, { request_id: requestId, asked_at: askedAt });

		it("keeps them together and in order behind a call drawn after the row", () => {
			expect(
				labels(
					replyTo(
						() => tool(POST, {}, { status: "running" }),
						() => tool("Read"),
						batched("a1", "t1"),
						batched("a2", "t1"),
						batched("a3", "t1"),
					),
				),
			).toEqual(["a1", "a2", "a3", "Read"]);
		});

		it("keeps each batch in order when two calls are open at once", () => {
			const order = labels(
				replyTo(
					() => tool(POST, {}, { status: "running" }),
					() => tool(POST, {}, { status: "running" }),
					batched("a1", "t1"),
					batched("a2", "t1"),
					batched("b1", "t2"),
					batched("b2", "t2"),
				),
			);
			// Which call a batch came from is not on the record, so either may
			// take either row; what holds is that neither batch is split or
			// reordered.
			expect(order).toHaveLength(4);
			expect(order.indexOf("a2")).toBe(order.indexOf("a1") + 1);
			expect(order.indexOf("b2")).toBe(order.indexOf("b1") + 1);
		});
	});

	describe("what became of it", () => {
		it("draws an answer", () => {
			const [card] = replyTo(() =>
				question("Which?", {
					status: "answered",
					answer: {
						request_id: "q-2",
						answers: ["SQLite"],
						answered_at: "2026-01-02T14:05:00Z",
					},
					answered_in: "m9",
				}),
			);
			expect(card).toMatchObject({
				status: "answered",
				answer: { answers: ["SQLite"] },
			});
			expect(card).not.toHaveProperty("unread");
		});

		// A Stop reopened the question; the card keeps what was said, and says
		// it went unread.
		it("draws an answer a Stop threw away as unread", () => {
			expect(
				replyTo(() =>
					question("Which?", {
						status: "open",
						discarded_answer: {
							request_id: "q-2",
							answers: ["SQLite"],
							answered_at: "2026-01-02T14:05:00Z",
						},
						discarded_in: "m9",
					}),
				),
			).toMatchObject([
				{ status: "answered", answer: { answers: ["SQLite"] }, unread: true },
			]);
		});

		it("draws a decline", () => {
			expect(
				replyTo(() =>
					question("Which?", {
						status: "declined",
						answer: {
							request_id: "q-2",
							declined: true,
							answered_at: "2026-01-02T14:05:00Z",
						},
					}),
				),
			).toMatchObject([{ status: "declined" }]);
		});

		it("draws a withdrawal, with why", () => {
			expect(
				replyTo(() =>
					question("Which?", { status: "withdrawn", reason: "step_done" }),
				),
			).toMatchObject([{ status: "cancelled", reason: "step_done" }]);
		});
	});
});

// Old transcripts hold the CLI's own blocking questions, several under one
// request id. They are drawn one card each, in the place of the ask call.
describe("a legacy multi-question record", () => {
	it("draws one card per question in the place of the call that asked", () => {
		const parts = replyTo(
			() => tool("AskUserQuestion", {}, { tool_use_id: "ask-1" }),
			() =>
				question("Which database?", {
					request_id: "q-1",
					legacy: true,
					tool_use_id: "ask-1",
				}),
			() =>
				question("Which region?", {
					request_id: "q-1",
					legacy: true,
					tool_use_id: "ask-1",
					status: "answered",
					answer: {
						request_id: "q-1",
						answers: ["eu-west-1"],
						answered_at: "",
					},
				}),
		);
		expect(parts).toMatchObject([
			{ type: "question_record", legacy: true, status: "pending" },
			{
				type: "question_record",
				legacy: true,
				status: "answered",
				answer: { answers: ["eu-west-1"] },
			},
		]);
		expect(parts[0]).not.toHaveProperty("toolUseId");
	});
});
