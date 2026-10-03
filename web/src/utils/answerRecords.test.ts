import { describe, expect, it } from "vitest";
import {
	type AnswerEntry,
	toAnswerParams,
	toAnswerRecords,
} from "./answerRecords";

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

	// The server decides where a note may go; the client only has to carry it,
	// beside an answer as beside a decline.
	it("carries a note beside an answer", () => {
		expect(
			toAnswerParams(
				toAnswerRecords([{ ...answered, note: " pin it to 3.45 " }]),
			),
		).toEqual([
			{ request_id: "r1", answers: ["SQLite"], note: "pin it to 3.45" },
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
