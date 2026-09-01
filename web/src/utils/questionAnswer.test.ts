import { describe, expect, it } from "vitest";
import type { AskUserQuestion, QuestionOption } from "../types/message";
import { formatAnswer, lookupAnswer, parseAnswer } from "./questionAnswer";

const options = (...labels: string[]): QuestionOption[] =>
	labels.map((label) => ({ label, description: "" }));

describe("parseAnswer", () => {
	it("returns an empty selection for a missing or empty answer", () => {
		expect(parseAnswer(undefined, options("A"))).toEqual({
			labels: [],
			otherText: null,
		});
		expect(parseAnswer("", options("A"))).toEqual({
			labels: [],
			otherText: null,
		});
	});

	it("restores a single-select answer", () => {
		expect(parseAnswer("React", options("React", "Vue"))).toEqual({
			labels: ["React"],
			otherText: null,
		});
	});

	it("restores a multi-select answer", () => {
		expect(parseAnswer("React, Vue", options("React", "Vue"))).toEqual({
			labels: ["React", "Vue"],
			otherText: null,
		});
	});

	it("restores labels that contain a comma", () => {
		const opts = options("Yes, always", "No", "Ask me, then decide");
		expect(parseAnswer("Yes, always", opts)).toEqual({
			labels: ["Yes, always"],
			otherText: null,
		});
		expect(parseAnswer("Yes, always, No", opts)).toEqual({
			labels: ["Yes, always", "No"],
			otherText: null,
		});
	});

	it("prefers the longest label when labels share a prefix", () => {
		const opts = options("React", "React Native");
		expect(parseAnswer("React Native", opts)).toEqual({
			labels: ["React Native"],
			otherText: null,
		});
		expect(parseAnswer("React, React Native", opts)).toEqual({
			labels: ["React", "React Native"],
			otherText: null,
		});
	});

	it("keeps commas inside the Other text", () => {
		expect(parseAnswer("Other: first, second, third", options("A"))).toEqual({
			labels: [],
			otherText: "first, second, third",
		});
	});

	it("keeps a literal 'Other: ' typed inside the Other text", () => {
		expect(
			parseAnswer("A, Other: I picked Other: on purpose", options("A")),
		).toEqual({
			labels: ["A"],
			otherText: "I picked Other: on purpose",
		});
	});

	it("prefers an exact option label over reading it as Other text", () => {
		expect(
			parseAnswer("Other: none of these", options("Other: none of these")),
		).toEqual({
			labels: ["Other: none of these"],
			otherText: null,
		});
	});

	it("restores a multi-select answer mixed with Other", () => {
		const opts = options("React", "Vue");
		expect(parseAnswer("React, Vue, Other: Svelte, please", opts)).toEqual({
			labels: ["React", "Vue"],
			otherText: "Svelte, please",
		});
	});

	it("falls back to Other text for unrecognized content", () => {
		expect(parseAnswer("Something nobody offered", options("A"))).toEqual({
			labels: [],
			otherText: "Something nobody offered",
		});
		expect(parseAnswer("A, leftover text", options("A"))).toEqual({
			labels: ["A"],
			otherText: "leftover text",
		});
	});

	it("round-trips whatever the form submits", () => {
		const opts = options("Yes, always", "React Native");
		const selection = {
			labels: ["Yes, always", "React Native"],
			otherText: "note, with comma",
		};
		expect(parseAnswer(formatAnswer(selection), opts)).toEqual(selection);
	});
});

describe("formatAnswer", () => {
	it("drops a picked but empty Other", () => {
		expect(formatAnswer({ labels: ["A"], otherText: "  " })).toBe("A");
	});
});

describe("lookupAnswer", () => {
	const question: AskUserQuestion = {
		question: "Which framework?",
		header: "Framework",
		options: options("React"),
		multiSelect: false,
	};

	it("looks up by question text", () => {
		expect(lookupAnswer(question, { "Which framework?": "React" }, 1)).toBe(
			"React",
		);
	});

	it("falls back to the header", () => {
		expect(lookupAnswer(question, { Framework: "React" }, 1)).toBe("React");
	});

	it("falls back to the only entry for a single question", () => {
		expect(lookupAnswer(question, { "some other key": "React" }, 1)).toBe(
			"React",
		);
	});

	it("ignores inherited Object members", () => {
		const named: AskUserQuestion = { ...question, question: "toString" };
		expect(
			lookupAnswer(named, { other: "a", another: "b" }, 2),
		).toBeUndefined();
	});

	it("reports a miss instead of guessing", () => {
		expect(lookupAnswer(question, { a: "1", b: "2" }, 2)).toBeUndefined();
		expect(lookupAnswer(question, undefined, 1)).toBeUndefined();
	});

	it("preserves an intentionally empty answer", () => {
		expect(lookupAnswer(question, { "Which framework?": "" }, 1)).toBe("");
	});
});
