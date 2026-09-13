import { Check, ChevronRight, CircleHelp, X } from "lucide-react";
import { useState } from "react";
import type {
	AskUserQuestion,
	AskUserQuestionRequest,
	QuestionStatus,
} from "../../types/message";
import {
	EMPTY_SELECTION,
	formatAnswer,
	lookupAnswer,
	parseAnswer,
	type QuestionSelection,
} from "../../utils/questionAnswer";
import { CollapsibleBody, ScrollableContent } from "../ui";

interface Props {
	request: AskUserQuestionRequest;
	status: QuestionStatus;
	savedAnswers?: Record<string, string>;
	onRespond?: (
		request: AskUserQuestionRequest,
		answers: Record<string, string> | null,
	) => void;
}

interface QuestionFormProps {
	question: AskUserQuestion;
	/** Groups the radio inputs of one question; must be unique per question. */
	name: string;
	selection: QuestionSelection;
	disabled: boolean;
	onSelectOption: (label: string) => void;
	onSelectOther: () => void;
	onOtherTextChange: (text: string) => void;
}

/**
 * The one and only renderer for a question, used for both the interactive and
 * the answered card. Sharing it is what keeps an answered card looking exactly
 * like the form the user filled in.
 */
function QuestionForm({
	question,
	name,
	selection,
	disabled,
	onSelectOption,
	onSelectOther,
	onOtherTextChange,
}: QuestionFormProps) {
	const inputType = question.multiSelect ? "checkbox" : "radio";
	const otherChecked = selection.otherText !== null;

	const rowClass = (selected: boolean) => {
		if (disabled) {
			// Selected rows use success (a settled fact) rather than accent
			// (actionable), and the rest recede so the eye lands on the answer.
			return `flex cursor-default items-start gap-2 rounded border p-2 ${
				selected
					? "border-th-success bg-th-success/10"
					: "border-th-border/60 opacity-45"
			}`;
		}
		return `flex cursor-pointer items-start gap-2 rounded border p-2 transition-colors ${
			selected
				? "border-th-accent bg-th-accent/10"
				: "border-th-border hover:border-th-accent/50"
		}`;
	};

	const inputClass = `mt-0.5 ${disabled ? "accent-th-success" : "accent-th-accent"}`;

	return (
		<div className="space-y-2">
			<div>
				<span className="inline-block rounded bg-th-accent/20 px-1.5 py-0.5 text-xs text-th-accent">
					{question.header}
				</span>
				<p className="mt-1 break-words text-sm text-th-text-primary">
					{question.question}
				</p>
			</div>

			<div className="space-y-1.5">
				{question.options.map((opt) => {
					const selected = selection.labels.includes(opt.label);
					return (
						<label key={opt.label} className={rowClass(selected)}>
							<input
								type={inputType}
								name={name}
								checked={selected}
								onChange={() => onSelectOption(opt.label)}
								className={inputClass}
							/>
							<div className="min-w-0 flex-1">
								<div className="break-words text-sm text-th-text-primary">
									{opt.label}
								</div>
								<div className="break-words text-xs leading-relaxed text-th-text-muted">
									{opt.description}
								</div>
							</div>
							{disabled && selected && (
								<Check className="mt-0.5 size-3 shrink-0 text-th-success" />
							)}
						</label>
					);
				})}

				<label className={rowClass(otherChecked)}>
					<input
						type={inputType}
						name={name}
						checked={otherChecked}
						onChange={() => onSelectOther()}
						className={inputClass}
					/>
					<div className="min-w-0 flex-1">
						<div className="text-sm text-th-text-primary">Other</div>
						{otherChecked &&
							(disabled ? (
								// A long answer left in the single-line input would be clipped
								// to one scrollable line; a paragraph wraps and shows all of it.
								<p className="mt-1 whitespace-pre-wrap break-words rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm text-th-text-primary">
									{selection.otherText}
								</p>
							) : (
								<input
									type="text"
									value={selection.otherText ?? ""}
									onChange={(e) => onOtherTextChange(e.target.value)}
									placeholder="Enter your answer..."
									className="mt-1 w-full rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
								/>
							))}
					</div>
					{disabled && otherChecked && (
						<Check className="mt-0.5 size-3 shrink-0 text-th-success" />
					)}
				</label>
			</div>
		</div>
	);
}

const statusConfig = {
	pending: { Icon: CircleHelp, color: "text-th-warning", label: "", chip: "" },
	answered: {
		Icon: Check,
		color: "text-th-success",
		label: "Answered",
		chip: "bg-th-success/15 text-th-success",
	},
	cancelled: {
		Icon: X,
		color: "text-th-error",
		label: "Cancelled",
		chip: "bg-th-error/15 text-th-error",
	},
	expired: {
		Icon: X,
		color: "text-th-text-muted",
		label: "Expired",
		chip: "bg-th-text-muted/15 text-th-text-muted",
	},
};

function summarize(selection: QuestionSelection): string {
	const parts = [...selection.labels];
	if (selection.otherText) parts.push(selection.otherText);
	return parts.join(" · ");
}

function AskUserQuestionItem({
	request,
	status,
	savedAnswers,
	onRespond,
}: Props) {
	const isPending = status === "pending";
	// Without onRespond there is no way to submit, so an editable form would be
	// a dead end.
	const readOnly = !isPending || !onRespond;

	const [expanded, setExpanded] = useState(isPending);
	// The card keeps its identity across pending -> answered, so it never
	// remounts; collapse explicitly on that one transition (and only that one,
	// otherwise the user could never reopen it).
	const [prevStatus, setPrevStatus] = useState(status);
	if (prevStatus !== status) {
		setPrevStatus(status);
		if (prevStatus === "pending") setExpanded(false);
	}

	const [selectedLabels, setSelectedLabels] = useState<
		Record<number, string[]>
	>({});
	const [otherPicked, setOtherPicked] = useState<Record<number, boolean>>({});
	// Kept apart from otherPicked so that trying another option and coming back
	// does not throw away what the user already typed.
	const [otherDraft, setOtherDraft] = useState<Record<number, string>>({});

	const { Icon, color, label: statusLabel, chip } = statusConfig[status];

	const headerSummary =
		request.questions.length > 0 ? request.questions[0].header : "Question";

	const localSelection = (index: number): QuestionSelection => ({
		labels: selectedLabels[index] ?? [],
		otherText: otherPicked[index] ? (otherDraft[index] ?? "") : null,
	});

	const restoredSelection = (
		question: AskUserQuestion,
	): { selection: QuestionSelection; unrestorable: boolean } => {
		if (status !== "answered") {
			return { selection: EMPTY_SELECTION, unrestorable: false };
		}
		const answer = lookupAnswer(
			question,
			savedAnswers,
			request.questions.length,
		);
		if (answer === undefined) {
			return { selection: EMPTY_SELECTION, unrestorable: true };
		}
		return {
			selection: parseAnswer(answer, question.options),
			unrestorable: false,
		};
	};

	const entries = request.questions.map((question, index) => {
		const { selection, unrestorable } = readOnly
			? restoredSelection(question)
			: { selection: localSelection(index), unrestorable: false };
		return { question, index, selection, unrestorable };
	});

	const answerSummary =
		status === "answered"
			? [
					summarize(entries[0]?.selection ?? EMPTY_SELECTION),
					entries.length > 1 ? `+${entries.length - 1}` : "",
				]
					.filter(Boolean)
					.join(" · ")
			: "";

	const handleOptionSelect = (index: number, label: string) => {
		const multiSelect = request.questions[index].multiSelect;
		setSelectedLabels((prev) => {
			if (!multiSelect) return { ...prev, [index]: [label] };
			const current = prev[index] ?? [];
			return {
				...prev,
				[index]: current.includes(label)
					? current.filter((l) => l !== label)
					: [...current, label],
			};
		});
		if (!multiSelect) setOtherPicked((prev) => ({ ...prev, [index]: false }));
	};

	const handleOtherSelect = (index: number) => {
		const multiSelect = request.questions[index].multiSelect;
		setOtherPicked((prev) => ({ ...prev, [index]: !prev[index] }));
		if (!multiSelect) setSelectedLabels((prev) => ({ ...prev, [index]: [] }));
	};

	const handleOtherTextChange = (index: number, text: string) => {
		setOtherDraft((prev) => ({ ...prev, [index]: text }));
	};

	const handleSubmit = () => {
		const finalAnswers: Record<string, string> = {};
		for (const { question, selection } of entries) {
			finalAnswers[question.question] = formatAnswer(selection);
		}
		onRespond?.(request, finalAnswers);
	};

	const canSubmit = entries.every(
		({ selection }) =>
			selection.labels.length > 0 || (selection.otherText ?? "").trim() !== "",
	);

	return (
		// The data attributes are how MessageList finds this card: the root is the
		// scroll/highlight target, the header row is what it observes and focuses.
		// scroll-mt-14 (56px) clears the pending-question pill, which floats at the
		// top of the list and can outlive the jump when more questions are waiting —
		// without it the pill would land on top of the card it just scrolled to.
		<div
			data-question-request-id={request.requestId}
			className={`scroll-mt-14 rounded text-xs ${isPending ? "border border-th-warning bg-th-warning/10" : "bg-th-bg-secondary"}`}
		>
			<button
				type="button"
				data-question-header=""
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<Icon className={`size-3 shrink-0 ${color}`} />
				<span className="shrink-0 text-th-accent">Question</span>
				<span className="max-w-[40%] shrink-0 truncate rounded bg-th-accent/20 px-1.5 py-0.5 text-th-accent">
					{headerSummary}
				</span>
				{statusLabel && (
					<span className={`shrink-0 rounded px-1.5 py-0.5 ${chip}`}>
						{statusLabel}
					</span>
				)}
				{answerSummary && (
					<span className="min-w-0 flex-1 truncate text-th-text-muted">
						{answerSummary}
					</span>
				)}
			</button>

			<CollapsibleBody expanded={expanded}>
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					{status === "cancelled" && (
						<div className="mb-3 rounded bg-th-error/10 px-2 py-1.5 text-th-error">
							You cancelled this question — no answer was sent.
						</div>
					)}
					{status === "expired" && (
						<div className="mb-3 rounded bg-th-bg-tertiary px-2 py-1.5 text-th-text-muted">
							This question expired before it was answered.
						</div>
					)}

					{/* Disabling the whole group at once keeps the read-only card
					    structurally identical to the form the user filled in. */}
					<fieldset
						disabled={readOnly}
						aria-label="Question form"
						className="space-y-4"
					>
						{entries.map(({ question, index, selection, unrestorable }) => (
							<div
								key={`${request.requestId}-${question.header}-${index}`}
								className="border-t border-th-border pt-4 first:border-t-0 first:pt-0"
							>
								{unrestorable && (
									<div className="mb-2 rounded bg-th-warning/10 px-2 py-1.5 text-th-warning">
										The answer for this question could not be restored.
									</div>
								)}
								<QuestionForm
									question={question}
									name={`${request.requestId}-${index}`}
									selection={selection}
									disabled={readOnly}
									onSelectOption={(label) => handleOptionSelect(index, label)}
									onSelectOther={() => handleOtherSelect(index)}
									onOtherTextChange={(text) =>
										handleOtherTextChange(index, text)
									}
								/>
							</div>
						))}
					</fieldset>
				</ScrollableContent>
			</CollapsibleBody>

			{isPending && onRespond && (
				<div className="flex justify-end gap-2 border-t border-th-border p-2">
					<button
						type="button"
						onClick={() => onRespond(request, null)}
						className="rounded bg-th-bg-secondary px-2 py-1 text-th-text-muted hover:bg-th-overlay-hover"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={!canSubmit}
						className="rounded bg-th-accent px-2 py-1 text-th-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Submit
					</button>
				</div>
			)}
		</div>
	);
}

export default AskUserQuestionItem;
