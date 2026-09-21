import { describe, expect, it, vi } from "vitest";
import type { Message } from "../types/message";
import {
	applyBackReference,
	applyServerEvent,
	isBackReference,
	normalizeEvent,
	prependHistoryPage,
	replayHistory,
	settleAfterProcessGone,
} from "./messageReducer";

vi.mock("../utils/uuid", () => {
	let counter = 0;
	return { generateUUID: () => `test-uuid-${++counter}` };
});

const partsOf = (message: Message) =>
	message.role === "assistant" ? message.parts : [];

const lastParts = (messages: Message[]) =>
	partsOf(messages[messages.length - 1]);

const posted = (requestId: string, header = "Database") => ({
	type: "question_posted",
	request_id: requestId,
	questions: [
		{
			question: "Which database should I use?",
			header,
			options: [{ label: "SQLite", description: "One file" }],
			multiSelect: false,
		},
	],
	asked_at: "2026-01-02T14:02:00Z",
});

const toolCall = (id: string, name: string) => ({
	type: "tool_call",
	tool_use_id: id,
	tool_name: name,
	tool_input: {},
});

/**
 * The transcript half of posted questions: how a `question_posted` record gets
 * on screen, what settles it, and — the two rules the old blocking prompt had
 * that this one must not inherit — that a process ending does not retire it and
 * that nothing but a record naming it can.
 */
describe("posted questions in the transcript", () => {
	it("draws a question the agent posted", () => {
		const messages = replayHistory([
			{ type: "message", content: "go" },
			posted("r1"),
		]);
		expect(lastParts(messages)).toMatchObject([
			{
				type: "question_record",
				status: "pending",
				record: { requestId: "r1", askedAt: "2026-01-02T14:02:00Z" },
			},
		]);
	});

	describe("taking the question_post tool row's place", () => {
		// Joined by position, because there is no `tool_use_id` to join on: the
		// call reaches the server over HTTP from the MCP endpoint. What the
		// server does guarantee is that the record is written *during* the call.
		it("hides the call the record was written during", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				toolCall("t1", "mcp__pockode__question_post"),
				posted("r1"),
				{ type: "tool_result", tool_use_id: "t1", tool_result: "posted" },
			]);
			expect(lastParts(messages)).toMatchObject([
				{ type: "question_record", record: { requestId: "r1" } },
			]);
		});

		it("takes only its own call, not an unrelated one beside it", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				toolCall("t1", "Read"),
				posted("r1"),
			]);
			expect(lastParts(messages)).toMatchObject([
				{ type: "tool_call", tool: { id: "t1" } },
				{ type: "question_record", record: { requestId: "r1" } },
			]);
		});

		// A join that misses leaves two rows rather than getting one wrong.
		it("degrades to two rows when the call is not on screen", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				toolCall("t1", "mcp__pockode__question_post"),
				{ type: "tool_result", tool_use_id: "t1", tool_result: "posted" },
				posted("r1"),
			]);
			expect(lastParts(messages)).toMatchObject([
				{ type: "tool_call", tool: { id: "t1" } },
				{ type: "question_record", record: { requestId: "r1" } },
			]);
		});
	});

	describe("what settles a card", () => {
		it("answers it from the message that carries the answer", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				posted("r1"),
				{ type: "done" },
				{
					type: "message",
					content: "Answering:\n\nQ: Which database should I use?\nA: SQLite",
					answering: [
						{
							request_id: "r1",
							header: "Database",
							question: "Which database should I use?",
							answers: ["SQLite"],
							answered_at: "2026-01-02T14:05:00Z",
						},
					],
				},
			]);
			expect(partsOf(messages[1])).toMatchObject([
				{
					type: "question_record",
					status: "answered",
					answer: { answers: ["SQLite"] },
				},
			]);
		});

		it("declines it when the user said they would not answer", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				posted("r1"),
				{ type: "done" },
				{
					type: "message",
					content: "Answering:\n\nQ: Which?\nA: (not answering)",
					answering: [
						{
							request_id: "r1",
							declined: true,
							answered_at: "2026-01-02T14:05:00Z",
						},
					],
				},
			]);
			expect(partsOf(messages[1])).toMatchObject([
				{ type: "question_record", status: "declined" },
			]);
		});

		it("cancels it when the agent withdrew it", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				posted("r1"),
				{
					type: "request_cancelled",
					request_id: "r1",
					resolved_at: "2026-01-02T14:05:00Z",
				},
			]);
			expect(partsOf(messages[1])).toMatchObject([
				{ type: "question_record", status: "cancelled" },
			]);
		});

		// Whichever record got there first is what happened; nothing arriving
		// after it can know better.
		it("leaves a card something else already settled alone", () => {
			const messages = replayHistory([
				{ type: "message", content: "go" },
				posted("r1"),
				{ type: "request_cancelled", request_id: "r1" },
				{
					type: "message",
					content: "late",
					answering: [
						{
							request_id: "r1",
							answers: ["SQLite"],
							answered_at: "2026-01-02T14:06:00Z",
						},
					],
				},
			]);
			expect(partsOf(messages[1])).toMatchObject([
				{ type: "question_record", status: "cancelled" },
			]);
		});
	});

	// The rule the old blocking prompt had that this one must not inherit: a
	// posted question belongs to the session, so the process that asked it dying
	// is not an ending for the question.
	it("survives the process that asked it", () => {
		const messages = settleAfterProcessGone(
			replayHistory([{ type: "message", content: "go" }, posted("r1")]),
		);
		expect(partsOf(messages[1])).toMatchObject([
			{ type: "question_record", status: "pending" },
		]);
	});

	it("survives a turn that ends with it still open", () => {
		const messages = replayHistory([
			{ type: "message", content: "go" },
			posted("r1"),
			{ type: "done" },
		]);
		expect(partsOf(messages[1])).toMatchObject([
			{ type: "question_record", status: "pending" },
		]);
	});

	describe("paging backwards", () => {
		// The message belongs where it was written, a page above; only the half
		// that settles the card is true of the older page.
		it("keeps an answering message as a back-reference", () => {
			expect(isBackReference({ type: "message", content: "hi" })).toBe(false);
			expect(
				isBackReference({
					type: "message",
					content: "hi",
					answering: [{ request_id: "r1" }],
				}),
			).toBe(true);
		});

		it("settles a card a page below without drawing the message twice", () => {
			const older = replayHistory([
				{ type: "message", content: "go" },
				posted("r1"),
			]);
			const answer = {
				type: "message",
				content: "Answering:",
				answering: [
					{
						request_id: "r1",
						answers: ["SQLite"],
						answered_at: "2026-01-02T14:05:00Z",
					},
				],
			};

			const caught = prependHistoryPage(older, [], {
				backReferences: [answer],
			});

			expect(caught.filter((m) => m.role === "user")).toHaveLength(1);
			const card = caught.flatMap(partsOf)[0];
			expect(card).toMatchObject({
				type: "question_record",
				status: "answered",
			});
		});

		it("replays an ordinary back-reference unchanged", () => {
			const older = replayHistory([
				{ type: "message", content: "go" },
				toolCall("t1", "Read"),
			]);
			const caught = applyBackReference(older, {
				type: "tool_result",
				tool_use_id: "t1",
				tool_result: "body",
			});
			expect(lastParts(caught)).toMatchObject([
				{ type: "tool_call", tool: { result: "body" } },
			]);
		});
	});

	describe("at the wire boundary", () => {
		it("reads one question out of the one-element list", () => {
			expect(normalizeEvent(posted("r1", "Region"))).toEqual({
				type: "question_posted",
				requestId: "r1",
				question: {
					question: "Which database should I use?",
					header: "Region",
					options: [{ label: "SQLite", description: "One file" }],
					multiSelect: false,
				},
				askedAt: "2026-01-02T14:02:00Z",
			});
		});

		// `asked_at` and `resolved_at` are optional on the wire; absent means the
		// record has no such moment, never the zero time.
		it("leaves an absent asked_at absent", () => {
			const event = normalizeEvent({
				type: "question_posted",
				request_id: "r1",
				questions: [
					{ question: "q", header: "h", multiSelect: false } as never,
				],
			});
			expect(event).toMatchObject({
				askedAt: undefined,
				question: { options: [] },
			});
		});

		it("carries a message's answering through", () => {
			expect(
				normalizeEvent({ type: "message", content: "hi", answering: [] }),
			).toMatchObject({ answering: undefined });
		});
	});

	it("draws an answering message as the answers, not as its body", () => {
		const messages = applyServerEvent([], {
			type: "message",
			content: "Answering:\n\nQ: Which?\nA: SQLite",
			answering: [
				{
					request_id: "r1",
					header: "Database",
					question: "Which?",
					answers: ["SQLite"],
					answered_at: "2026-01-02T14:05:00Z",
				},
			],
		});
		expect(messages[0]).toMatchObject({
			role: "user",
			answering: [{ request_id: "r1", answers: ["SQLite"] }],
		});
	});
});
// Old transcripts hold `ask_user_question` records that carried several questions
// under one `request_id`, answered by one `question_response`. They render as one
// card each, and each card has to find *its own* answer in that map.
describe("a legacy multi-question record", () => {
	const twoQuestions = {
		type: "ask_user_question",
		request_id: "q-1",
		tool_use_id: "t1",
		questions: [
			{
				question: "Which database?",
				header: "Database",
				options: [{ label: "Postgres", description: "" }],
				multiSelect: false,
			},
			{
				question: "Which region?",
				header: "Region",
				options: [{ label: "eu-west-1", description: "" }],
				multiSelect: false,
			},
		],
	};

	it("draws one card per question, all sharing the request id", () => {
		const parts = partsOf(replayHistory([twoQuestions])[0]);
		expect(parts).toMatchObject([
			{ type: "question_record", legacy: true, record: { requestId: "q-1" } },
			{ type: "question_record", legacy: true, record: { requestId: "q-1" } },
		]);
	});

	it("gives each card the answer keyed by its own question", () => {
		const parts = partsOf(
			replayHistory([
				twoQuestions,
				{
					type: "question_response",
					request_id: "q-1",
					answers: {
						"Which database?": "Postgres",
						"Which region?": "eu-west-1",
					},
				},
			])[0],
		);
		expect(parts).toMatchObject([
			{ status: "answered", answer: { answers: ["Postgres"] } },
			{ status: "answered", answer: { answers: ["eu-west-1"] } },
		]);
	});

	// The degradation `lookupAnswer` allows — "one question, one entry, they must
	// be each other" — must not fire here. Handing the single entry to both cards
	// would put one user's answer on a question they never answered.
	it("leaves a card whose answer the map does not name empty", () => {
		const parts = partsOf(
			replayHistory([
				twoQuestions,
				{
					type: "question_response",
					request_id: "q-1",
					answers: { "a key matching neither question": "Postgres" },
				},
			])[0],
		);
		// Both are settled — the response says the request was answered — and
		// neither claims a selection it cannot account for.
		expect(parts).toMatchObject([
			{ status: "answered", answer: { answers: [] } },
			{ status: "answered", answer: { answers: [] } },
		]);
	});

	// The single-question case is where that degradation is useful, and it still
	// works: one card, one entry, no key match needed.
	it("still falls back to the only entry for a single-question record", () => {
		const parts = partsOf(
			replayHistory([
				{ ...twoQuestions, questions: [twoQuestions.questions[0]] },
				{
					type: "question_response",
					request_id: "q-1",
					answers: { "a key matching nothing": "Postgres" },
				},
			])[0],
		);
		expect(parts).toMatchObject([
			{ status: "answered", answer: { answers: ["Postgres"] } },
		]);
	});
});
