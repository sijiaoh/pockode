import type { AskUserQuestion, QuestionOption } from "../types/message";

/**
 * A user's answer to one question, in the shape the form renders it.
 *
 * This module is otherwise about reading the legacy flat answer format back; this
 * type and {@link EMPTY_SELECTION} are what `QuestionForm` speaks, and both paths
 * end here.
 */
export interface QuestionSelection {
	labels: string[];
	/** null = the "Other" option was not used. */
	otherText: string | null;
}

export const EMPTY_SELECTION: QuestionSelection = {
	labels: [],
	otherText: null,
};

// The flat answer format of the CLI's own blocking question: labels joined by
// ", ", with an optional trailing `Other: <free text>` entry. **Read only.**
// Nothing writes it any more — an answer today keeps its labels and the user's
// own words in separate fields (`QuestionAnswerRecord`) — but transcripts written
// before that hold it, and it is the only trace of what those answers were.
const OTHER_PREFIX = "Other: ";
const SEPARATOR = ", ";

/**
 * Parses a legacy flat answer back into the two halves a form draws.
 *
 * Splitting on ", " is not safe: option labels may contain commas and free text
 * almost always does. Instead consume known labels greedily from the start, then
 * treat everything after `Other: ` (or anything unrecognized) as free text so
 * nothing the user typed is lost.
 */
export function parseAnswer(
	answer: string | undefined,
	options: QuestionOption[],
): QuestionSelection {
	if (!answer) return { labels: [], otherText: null };

	// An exact label match is that option, even for a label the loop below would
	// read as something else — one starting with "Other: ", say.
	if (options.some((opt) => opt.label === answer)) {
		return { labels: [answer], otherText: null };
	}

	const labels: string[] = [];
	let otherText: string | null = null;
	let cursor = 0;

	while (cursor < answer.length) {
		const rest = answer.slice(cursor);

		if (rest.startsWith(OTHER_PREFIX)) {
			otherText = rest.slice(OTHER_PREFIX.length);
			cursor = answer.length;
			break;
		}

		// Longest match wins so "React" cannot steal "React Native".
		let matched: string | null = null;
		for (const opt of options) {
			if (!rest.startsWith(opt.label)) continue;
			const after = rest.slice(opt.label.length);
			if (after !== "" && !after.startsWith(SEPARATOR)) continue;
			if (matched === null || opt.label.length > matched.length) {
				matched = opt.label;
			}
		}
		if (matched === null) break;

		labels.push(matched);
		cursor += matched.length + SEPARATOR.length;
	}

	const remainder = cursor < answer.length ? answer.slice(cursor) : "";
	if (remainder) otherText = remainder;

	return { labels, otherText };
}

/**
 * Finds one question's answer in a legacy `question_response` map.
 *
 * The map was written by whichever client answered, keyed by question text, and
 * persisted verbatim — so the first lookup normally hits. The rest is graceful
 * degradation for a record nobody can go back and fix: degrade through the
 * plausible keys, and report a miss rather than silently rendering an answered
 * card as if nothing had been picked.
 */
export function lookupAnswer(
	question: AskUserQuestion,
	savedAnswers: Record<string, string> | undefined,
	questionCount: number,
): string | undefined {
	if (!savedAnswers) return undefined;

	// hasOwn, not `in`: this is a parsed-JSON object, so a question named after an
	// Object.prototype member would otherwise "find" an inherited function.
	if (Object.hasOwn(savedAnswers, question.question)) {
		return savedAnswers[question.question];
	}
	if (Object.hasOwn(savedAnswers, question.header)) {
		return savedAnswers[question.header];
	}

	const entries = Object.values(savedAnswers);
	if (questionCount === 1 && entries.length === 1) return entries[0];

	return undefined;
}
