import { Check, ChevronRight, CircleHelp, X } from "lucide-react";
import { useState } from "react";
import type {
	ExpiryReason,
	QuestionAnswerRecord,
	QuestionRecord,
	QuestionRecordStatus,
} from "../../types/message";
import {
	EMPTY_SELECTION,
	type QuestionSelection,
} from "../../utils/questionAnswer";
import { CollapsibleBody, ScrollableContent } from "../ui";
import QuestionForm from "./QuestionForm";

interface Props {
	record: QuestionRecord;
	status: QuestionRecordStatus;
	/** What was said back; set on `answered` and `declined`. */
	answer?: QuestionAnswerRecord;
	/** Why it was withdrawn, when the server could say. */
	reason?: ExpiryReason;
	/**
	 * Whether this is a question the CLI asked through its own blocking tool, read
	 * from a transcript written before Pockode stopped letting a CLI ask one.
	 *
	 * It changes one thing: a `pending` legacy card cannot be answered, because
	 * the process that was holding that tool call open is long gone. So it says so
	 * and offers no way in, rather than showing a button leading to a sheet the
	 * question is not in.
	 */
	legacy?: boolean;
	/**
	 * Opens the answer panel on this question. Absent when the host cannot
	 * answer — a card whose session is not the one on screen — and the body then
	 * states what is being asked and stops there.
	 */
	onAnswer?: (requestId: string) => void;
}

const statusConfig: Record<
	QuestionRecordStatus,
	{ label: string; chip: string }
> = {
	pending: { label: "Pending", chip: "bg-th-warning/15 text-th-warning" },
	answered: { label: "Answered", chip: "bg-th-success/15 text-th-success" },
	// Declined and cancelled both mean "no answer was given" and differ only in
	// who decided, which is a sentence rather than a hue: two muted chips with
	// one line each beats two colours the user has to have learnt.
	//
	// An opaque surface rather than the `/15` self-tint above: muted tinting
	// itself drags the backdrop towards the text, so raising the token raises
	// both halves and the ratio barely moves.
	declined: { label: "Declined", chip: "bg-th-bg-tertiary text-th-text-muted" },
	cancelled: {
		label: "Cancelled",
		chip: "bg-th-bg-tertiary text-th-text-muted",
	},
};

/**
 * What took the question back, when the server said. Appended to
 * "The agent withdrew this question." rather than replacing it, because it is
 * still true — these are both Pockode withdrawing on the agent's behalf.
 *
 * Absent for the plain case, which is the agent calling `question_cancel`
 * itself: there is nothing to add and inventing a cause would be worse than the
 * sentence already there. The two reasons a *permission* card can carry never
 * reach this one, so they get no rows (see `ExpiryReason`).
 */
function withdrawalCause(reason: ExpiryReason | undefined): string | null {
	if (reason === "work_closed") return " The work it belonged to was closed.";
	if (reason === "step_done") return " The step it was asked during finished.";
	return null;
}

/** The sentence that tells the states with no answer in them apart. */
function outcomeLine(
	status: QuestionRecordStatus,
	answer: QuestionAnswerRecord | undefined,
	legacy: boolean,
): string | null {
	if (status === "declined") {
		const note = answer?.note?.trim();
		return note
			? `You declined to answer this — "${note}"`
			: "You declined to answer this.";
	}
	if (status === "cancelled") return "The agent withdrew this question.";
	// An answer with no resolver on it is the user's: every record written
	// before an agent could answer at all was, and the field is absent on those
	// (see `QuestionAnswerRecord.resolved_by`). Only the other case is worth a
	// sentence — the reader is looking at an answered question they never saw.
	if (status === "answered" && answer?.resolved_by?.kind === "agent") {
		const title = answer.resolved_by.title;
		return title
			? `Answered by the agent working on "${title}", not by you.`
			: "Answered by another agent, not by you.";
	}
	// The one thing a legacy card says that a current one cannot. Said here
	// rather than left to the chip, because "Pending" on its own promises
	// something to do.
	if (status === "pending" && legacy) {
		return "This was asked through the CLI's own tool, which held the turn open for the answer. It can no longer be answered.";
	}
	return null;
}

/**
 * What an answered card fills its read-only form in with.
 *
 * No guessing is needed: the record already keeps the two halves apart, because
 * the agent has to be able to tell an option it offered from what the user
 * wrote. `answers` are ticked options and `text` goes in the **Other** input —
 * or, for a question that offered nothing to pick, is the whole answer.
 */
function answeredSelection(
	answer: QuestionAnswerRecord | undefined,
): QuestionSelection {
	if (!answer) return EMPTY_SELECTION;
	return {
		labels: answer.answers ?? [],
		otherText: answer.text ?? null,
	};
}

/**
 * The record of a question the agent posted, in one of four states.
 *
 * A record and nothing more: it holds no form the user can submit and no live
 * state. Whether the question is still open is the session's turn's answer, and
 * answering happens in the sheet — which is why a `pending` body offers a
 * button that opens that sheet rather than a form of its own
 * (docs/answering-ui.md §6).
 *
 * Collapsed by default in every state, `pending` included, and it never opens
 * itself: an open question is announced by the strip above the composer, which
 * is on screen, and a card that expanded itself would scroll the transcript
 * under the reader to show them something they cannot act on there.
 */
function QuestionRecordItem({
	record,
	status,
	answer,
	reason,
	legacy = false,
	onAnswer,
}: Props) {
	const [expanded, setExpanded] = useState(false);
	const { label: statusLabel, chip } = statusConfig[status];
	const outcome = outcomeLine(status, answer, legacy);
	const isAnswered = status === "answered";
	const selection = isAnswered ? answeredSelection(answer) : EMPTY_SELECTION;

	// The summary the collapsed header carries. Only an answered card has one —
	// the rest say everything they have to say in the chip.
	const answerSummary = isAnswered
		? [...(answer?.answers ?? []), ...(answer?.text ? [answer.text] : [])].join(
				" · ",
			)
		: "";

	return (
		// No jump handle, unlike a permission card: nothing scrolls the transcript to
		// this one. Answering happens in the sheet, which reads the session's
		// unanswered list and works whether or not this card is even loaded
		// (docs/answering-ui.md §8).
		<div
			// The warning frame means "there is something for you here". A legacy
			// pending card has nothing for anyone, so it recedes like a settled one.
			className={`rounded text-xs ${status === "pending" && !legacy ? "border border-th-warning bg-th-warning/10" : "bg-th-bg-secondary"}`}
		>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<StatusGlyph status={status} legacy={legacy} />
				<span className="shrink-0 text-th-accent">Question</span>
				<span className="max-w-[40%] shrink-0 truncate rounded bg-th-accent/20 px-1.5 py-0.5 text-th-text-primary">
					{record.question.header || "Question"}
				</span>
				<span className={`shrink-0 rounded px-1.5 py-0.5 ${chip}`}>
					{statusLabel}
				</span>
				{answerSummary && (
					<span className="min-w-0 flex-1 truncate text-th-text-muted">
						{answerSummary}
					</span>
				)}
			</button>

			<CollapsibleBody expanded={expanded}>
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					{outcome && (
						<p className="mb-3 rounded bg-th-bg-tertiary px-2 py-1.5 text-th-text-muted">
							{outcome}
							{withdrawalCause(reason)}
						</p>
					)}
					{/* Always disabled: this card is a record. An answered one shows
					    the selection filled in, which is what keeps it looking like the
					    form that was filled in; every other state shows the question
					    with nothing picked. */}
					<fieldset disabled aria-label="Question" className="space-y-2">
						<QuestionForm
							question={record.question}
							askedAt={record.askedAt}
							name={record.requestId}
							selection={selection}
							disabled
							onSelectOption={noop}
							onSelectOther={noop}
							onOtherTextChange={noop}
						/>
					</fieldset>
				</ScrollableContent>
			</CollapsibleBody>

			{/* In the body rather than on the header row: the header row is the
			    expand toggle and its slot order is the tool row's grammar, which has
			    nowhere to put a second control. A card that states `Pending` and
			    offers nothing is a dead end, which is why this one concession to the
			    stream exists at all (docs/answering-ui.md §4). It carries no state —
			    it calls the same opener the strip does. */}
			{status === "pending" && !legacy && expanded && onAnswer && (
				<div className="flex justify-end border-t border-th-border p-2">
					<button
						type="button"
						onClick={() => onAnswer(record.requestId)}
						className="touch-target rounded px-1 text-th-accent underline transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
					>
						Answer this
					</button>
				</div>
			)}
		</div>
	);
}

function StatusGlyph({
	status,
	legacy,
}: {
	status: QuestionRecordStatus;
	legacy: boolean;
}) {
	if (status === "answered") {
		return <Check className="size-3 shrink-0 text-th-success" />;
	}
	if (status === "cancelled") {
		return <X className="size-3 shrink-0 text-th-text-muted" />;
	}
	return (
		<CircleHelp
			className={`size-3 shrink-0 ${status === "pending" && !legacy ? "text-th-warning" : "text-th-text-muted"}`}
		/>
	);
}

const noop = () => {};

export default QuestionRecordItem;
