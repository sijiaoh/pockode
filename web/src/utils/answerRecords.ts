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
	/**
	 * The user's optional line beside the answer: the reason beside a decline, or
	 * a remark beside the options picked. Where it may go is the server's rule
	 * (`chat.validateNote`); this only carries it.
	 */
	note?: string;
}

/**
 * The same entries as answer *records*: what the server will write, as the
 * client already knows it.
 *
 * One shape crosses out of the sheet, and the two things that read it narrow it
 * themselves — the wire takes {@link toAnswerParams}, and the bubble takes this
 * whole thing. There is no message body beside it: the server writes the text
 * the agent reads from these same answers, whoever gave them, so the wording
 * lives in one place (`server/chat/questions.go`, `answerMessage`).
 *
 * The header and the question are in here for the bubble's sake: it draws the
 * answer beside what was asked, and the card that asked may be thousands of
 * records back.
 *
 * `answered_at` is this client's clock, not the server's. It is only ever the
 * echo's: the server stamps its own on the record it writes, and a reload shows
 * that one. Nothing compares the two.
 */
export function toAnswerRecords(
	entries: AnswerEntry[],
): QuestionAnswerRecord[] {
	const answeredAt = new Date().toISOString();
	return entries.map((entry) => {
		// Omitted rather than sent empty: absent and "" mean the same thing, and
		// one of the two is what the server writes back.
		const note = entry.note?.trim();
		const text = entry.text?.trim();
		return {
			request_id: entry.requestId,
			header: entry.header,
			question: entry.question,
			answered_at: answeredAt,
			...(entry.declined
				? { declined: true }
				: { answers: entry.answers, ...(text ? { text } : {}) }),
			...(note ? { note } : {}),
		};
	});
}

/** The wire form: a record narrowed to what `chat.message` is asked for. */
export function toAnswerParams(
	records: QuestionAnswerRecord[],
): QuestionAnswerParams[] {
	return records.map((record) => ({
		request_id: record.request_id,
		...(record.declined
			? { declined: true }
			: {
					answers: record.answers ?? [],
					...(record.text ? { text: record.text } : {}),
				}),
		...(record.note ? { note: record.note } : {}),
	}));
}
