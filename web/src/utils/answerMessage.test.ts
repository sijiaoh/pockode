import { describe, expect, it } from "vitest";
import {
	type AnswerEntry,
	buildAnswerMessage,
	toAnswerParams,
	toAnswerRecords,
} from "./answerMessage";

const answered: AnswerEntry = {
	requestId: "r1",
	header: "Database",
	question: "Which database should I use?",
	answers: ["SQLite"],
	declined: false,
};

const declined: AnswerEntry = {
	requestId: "r2",
	header: "Region",
	question: "Which region?",
	answers: [],
	declined: true,
	note: "already said it above",
};

describe("buildAnswerMessage", () => {
	// The text is the only half the agent ever reads — `answering` is Pockode's
	// own structure and never reaches the CLI — so each entry has to carry its
	// question with it or a bare label arrives as an answer to nothing.
	it("carries each question with its answer", () => {
		expect(buildAnswerMessage([answered])).toBe(
			"Answering:\n\nQ: Which database should I use?\nA: SQLite",
		);
	});

	it("reads the same for one question and for several", () => {
		expect(buildAnswerMessage([answered, declined])).toBe(
			[
				"Answering:",
				"",
				"Q: Which database should I use?",
				"A: SQLite",
				"",
				"Q: Which region?",
				"A: (not answering) already said it above",
			].join("\n"),
		);
	});

	// A blank line would read to the agent as "the user said nothing", which is
	// what it was already looking at before the message arrived.
	it("says a decline in words, note or no note", () => {
		expect(buildAnswerMessage([{ ...declined, note: undefined }])).toContain(
			"A: (not answering)",
		);
	});

	it("joins a multi-select answer", () => {
		expect(
			buildAnswerMessage([
				{
					requestId: "r3",
					header: "Which",
					question: "Which?",
					answers: ["A", "B"],
					declined: false,
				},
			]),
		).toContain("A: A · B");
	});

	// This prose is the only half the CLI reads, so the split the record keeps
	// structurally has to be said here in words. Unmarked, the sentence would
	// arrive as a third option the agent had offered.
	it("marks the user's own words when they sit beside a label", () => {
		expect(
			buildAnswerMessage([
				{ ...answered, answers: ["Node"], text: "pin it to 22" },
			]),
		).toContain("A: Node · and, in their own words: pin it to 22");
	});

	// And carries no marker when it stands alone: there is nothing beside it to
	// be mistaken for, and this is every answer to a question that offered no
	// options.
	it("writes a lone free-text answer plainly", () => {
		expect(
			buildAnswerMessage([{ ...answered, answers: [], text: "use SQLite" }]),
		).toContain("A: use SQLite");
	});

	it("drops free text that is only whitespace", () => {
		expect(
			buildAnswerMessage([{ ...answered, answers: ["SQLite"], text: "  " }]),
		).toContain("A: SQLite");
	});
});

describe("toAnswerRecords", () => {
	// The bubble draws each answer beside what was asked, and the card that
	// asked may be thousands of records back — so the header and the question
	// travel with the answer rather than being resolved from it.
	it("carries what was asked along with what was said", () => {
		const [record] = toAnswerRecords([answered]);
		expect(record).toMatchObject({
			request_id: "r1",
			header: "Database",
			question: "Which database should I use?",
			answers: ["SQLite"],
		});
		expect(record.answered_at).not.toBe("");
	});

	it("writes a decline as a decline, with no empty answer beside it", () => {
		expect(toAnswerRecords([declined])[0]).toMatchObject({
			request_id: "r2",
			declined: true,
			note: "already said it above",
		});
		expect(toAnswerRecords([declined])[0].answers).toBeUndefined();
	});

	// `answers` holds labels and `text` the user's own words, and they stay apart
	// all the way to the server — which checks the first against the question and
	// never the second. Collapsing them would make that check meaningless.
	it("keeps the user's own words in a field of their own", () => {
		expect(
			toAnswerRecords([
				{ ...answered, answers: ["Node"], text: "pin to 22" },
			])[0],
		).toMatchObject({ answers: ["Node"], text: "pin to 22" });
	});

	// Absent and empty say the same thing, and absent is what the server writes
	// back — so one of the two has to be chosen and it may as well be the one a
	// reload produces.
	it("leaves whitespace-only free text off entirely", () => {
		expect(
			toAnswerRecords([{ ...answered, text: "   " }])[0].text,
		).toBeUndefined();
	});
});

describe("toAnswerParams", () => {
	it("narrows a record to what the wire is asked for", () => {
		expect(toAnswerParams(toAnswerRecords([answered, declined]))).toEqual([
			{ request_id: "r1", answers: ["SQLite"] },
			{ request_id: "r2", declined: true, note: "already said it above" },
		]);
	});

	it("leaves an empty note off", () => {
		expect(
			toAnswerParams(toAnswerRecords([{ ...declined, note: "   " }])),
		).toEqual([{ request_id: "r2", declined: true }]);
	});

	it("carries the user's own words through to the wire", () => {
		expect(
			toAnswerParams(
				toAnswerRecords([{ ...answered, answers: [], text: "use SQLite" }]),
			),
		).toEqual([{ request_id: "r1", answers: [], text: "use SQLite" }]);
	});
});
