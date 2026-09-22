import { Check } from "lucide-react";
import type { AskUserQuestion } from "../../types/message";
import type { QuestionSelection } from "../../utils/questionAnswer";

export interface QuestionFormProps {
	question: AskUserQuestion;
	/** When it was asked, as an ISO string. Absent draws no time. */
	askedAt?: string;
	/**
	 * Whether a question that offers options also offers **Other**.
	 *
	 * True for the CLI's own blocking prompt, which takes any text back. False
	 * for a posted question: the server refuses an answer naming a label the
	 * question did not offer (`chat.validateAnswer`), so an Other row there
	 * would be a control whose every use is refused. Ignored when the question
	 * offers no options at all — the whole answer is free text then.
	 */
	allowOther?: boolean;
	/** Groups the radio inputs of one question; must be unique per question. */
	name: string;
	selection: QuestionSelection;
	disabled: boolean;
	onSelectOption: (label: string) => void;
	onSelectOther: () => void;
	onOtherTextChange: (text: string) => void;
}

/**
 * The one and only renderer for a question, used by every surface that draws
 * one: the answer panel's blocks, the record card's read-only body, and the
 * CLI's own blocking prompt. Sharing it is what keeps an answered card looking
 * exactly like the form that was filled in.
 *
 * Three shapes, decided by the question itself (docs/answering-ui.md §3):
 * radios with an **Other** row, checkboxes with one, and — when the question
 * offers no options at all — a multi-line textarea with no Other row, because
 * there is nothing for it to be other *than*. That third shape is what a free
 * text request becomes, and it is multi-line where the Other input is not:
 * the answers that arrive there are paragraphs, not labels.
 */
function QuestionForm({
	question,
	askedAt,
	allowOther = true,
	name,
	selection,
	disabled,
	onSelectOption,
	onSelectOther,
	onOtherTextChange,
}: QuestionFormProps) {
	const hasOptions = question.options.length > 0;
	const inputType = question.multiSelect ? "checkbox" : "radio";
	const otherChecked = selection.otherText !== null;

	const rowClass = (selected: boolean) => {
		// A read-only row is not aimed at, so it owes no hit area; an option the
		// user picks from is the one place in this design a finger lands on a row.
		const reach = disabled ? "" : " pointer-coarse:min-h-11";
		if (disabled) {
			// Selected rows use success (a settled fact) rather than accent
			// (actionable), and the rest recede so the eye lands on the answer.
			return `flex cursor-default items-start gap-2 rounded border p-2${reach} ${
				selected
					? "border-th-success bg-th-success/10"
					: "border-th-border/60 opacity-45"
			}`;
		}
		return `flex cursor-pointer items-start gap-2 rounded border p-2 transition-colors${reach} ${
			selected
				? "border-th-accent bg-th-accent/10"
				: "border-th-border hover:border-th-accent/50"
		}`;
	};

	const inputClass = `mt-0.5 ${disabled ? "accent-th-success" : "accent-th-accent"}`;

	return (
		<div className="space-y-2">
			<div>
				<span className="inline-block rounded bg-th-accent/20 px-1.5 py-0.5 text-xs text-th-text-primary">
					{question.header}
				</span>
				{/* Opposite the chip, in the reader's own locale. It is what tells two
				    questions with the same header apart, and what says how long one
				    has been waiting. */}
				{formatAskedAt(askedAt) && (
					<span className="float-right text-xs text-th-text-muted">
						{formatAskedAt(askedAt)}
					</span>
				)}
				<p className="mt-1 break-words text-sm text-th-text-primary">
					{question.question}
				</p>
			</div>

			{hasOptions ? (
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
									{/* Only when there is one: an option may carry no
									    description at all, and an empty line of its own
									    leading is a gap under every option in the list. */}
									{opt.description && (
										<div className="break-words text-xs leading-relaxed text-th-text-muted">
											{opt.description}
										</div>
									)}
								</div>
								{disabled && selected && (
									<Check className="mt-0.5 size-3 shrink-0 text-th-success" />
								)}
							</label>
						);
					})}

					{(allowOther || otherChecked) && (
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
										// A long answer left in the single-line input would be
										// clipped to one scrollable line; a paragraph wraps and
										// shows all of it.
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
					)}
				</div>
			) : disabled ? (
				// A free-text question with no answer is the ordinary state of a
				// pending, declined or withdrawn card. Drawing the answer box empty
				// would show a filled-in form with nothing in it.
				selection.otherText === null ? (
					<p className="text-xs text-th-text-muted">No answer was given.</p>
				) : (
					<p className="whitespace-pre-wrap break-words rounded border border-th-success bg-th-success/10 px-2 py-1 text-sm text-th-text-primary">
						{selection.otherText}
					</p>
				)
			) : (
				<textarea
					aria-label={question.header || "Your answer"}
					value={selection.otherText ?? ""}
					onChange={(e) => onOtherTextChange(e.target.value)}
					placeholder="Your answer"
					rows={3}
					className="w-full resize-y rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
				/>
			)}
		</div>
	);
}

/** "14:02" in the reader's own locale, or nothing for a time that is not one. */
function formatAskedAt(askedAt: string | undefined): string | undefined {
	if (!askedAt) return undefined;
	const at = new Date(askedAt);
	if (Number.isNaN(at.getTime())) return undefined;
	return at.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

export default QuestionForm;
