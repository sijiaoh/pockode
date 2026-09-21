import type {
	QuestionAnswerParams,
	QuestionAnswerRecord,
} from "../types/message";

/** One question and what the user said back, as the sheet holds it. */
export interface AnswerEntry {
	requestId: string;
	/** The short label; it travels with the answer so the bubble can draw it. */
	header: string;
	question: string;
	/** The option labels picked. Empty when answered in the user's own words. */
	answers: string[];
	/** What the user wrote themselves — **Other**, or a free-text answer. */
	text?: string;
	declined: boolean;
	/** The optional line the user added beside a decline. */
	note?: string;
}

/**
 * The body of the message an answer travels as.
 *
 * This is the one place the wording lives, because the text is the only half of
 * an answer the agent ever reads: `answering` is Pockode's own structure and
 * never reaches the CLI. A bare option label would arrive as an answer to
 * nothing, so each entry carries its question with it.
 *
 * The lead is one word rather than a sentence so that one question and five
 * read the same (docs/answering-ui.md §3).
 */
export function buildAnswerMessage(entries: AnswerEntry[]): string {
	const body = entries.map(formatEntry).join("\n\n");
	return `Answering:\n\n${body}`;
}

function formatEntry(entry: AnswerEntry): string {
	return `Q: ${entry.question}\nA: ${formatAnswerLine(entry)}`;
}

/**
 * What follows `A:`.
 *
 * A decline is written as a phrase rather than left blank, because a blank
 * answer reads to the agent as "the user said nothing" — which is what it was
 * already looking at before the message arrived.
 *
 * The user's own words are marked as such **when they sit beside a label**. The
 * prose is the only half of an answer the CLI reads, so the distinction the
 * record keeps structurally (`answers` against `text`) has to be said here in
 * words — an unmarked sentence next to two option labels would read as a third
 * option the agent had offered.
 *
 * A lone free text carries no marker, deliberately: there is nothing beside it to
 * be mistaken for, and every answer to a question that offered no options is this
 * shape, so marking them all would put a qualifier on the common case to serve
 * the rare one. What is left unsaid is narrow and harmless — the agent cannot
 * tell "picked your option" from "typed those same words into Other" — and
 * neither reading changes what the user meant.
 */
function formatAnswerLine(entry: AnswerEntry): string {
	if (entry.declined) {
		const note = entry.note?.trim();
		return note ? `(not answering) ${note}` : "(not answering)";
	}
	const parts = [...entry.answers];
	const text = entry.text?.trim();
	if (text) {
		parts.push(
			entry.answers.length > 0 ? `and, in their own words: ${text}` : text,
		);
	}
	return parts.join(" · ");
}

/**
 * The same entries as answer *records*: what the server will write, as the
 * client already knows it.
 *
 * One shape crosses out of the sheet, and the two things that read it narrow it
 * themselves — the wire takes {@link toAnswerParams}, and the bubble takes this
 * whole thing. The header and the question are in here for the bubble's sake:
 * it draws the answer beside what was asked, and the card that asked may be
 * thousands of records back.
 *
 * `answered_at` is this client's clock, not the server's. It is only ever the
 * echo's: the server stamps its own on the record it writes, and a reload shows
 * that one. Nothing compares the two.
 */
export function toAnswerRecords(
	entries: AnswerEntry[],
): QuestionAnswerRecord[] {
	const answeredAt = new Date().toISOString();
	return entries.map((entry) => ({
		request_id: entry.requestId,
		header: entry.header,
		question: entry.question,
		answered_at: answeredAt,
		...(entry.declined
			? {
					declined: true,
					...(entry.note?.trim() ? { note: entry.note.trim() } : {}),
				}
			: {
					answers: entry.answers,
					// Omitted rather than sent empty: absent and "" mean the same
					// thing, and one of the two is what the server writes back.
					...(entry.text?.trim() ? { text: entry.text.trim() } : {}),
				}),
	}));
}

/** The wire form: a record narrowed to what `chat.message` is asked for. */
export function toAnswerParams(
	records: QuestionAnswerRecord[],
): QuestionAnswerParams[] {
	return records.map((record) =>
		record.declined
			? {
					request_id: record.request_id,
					declined: true,
					...(record.note ? { note: record.note } : {}),
				}
			: {
					request_id: record.request_id,
					answers: record.answers ?? [],
					...(record.text ? { text: record.text } : {}),
				},
	);
}
