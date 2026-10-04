import { Check, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import type { AskUserQuestion } from "../../types/message";
import {
	noteApplies,
	type QuestionSelection,
} from "../../utils/questionAnswer";
import { MarkdownContent, RecommendedTag } from "../ui";
import { inputClass } from "../ui/inputClass";
import ChoiceInput, { type ChoiceTone } from "./ChoiceInput";

export interface QuestionFormProps {
	question: AskUserQuestion;
	/** When it was asked, as an ISO string. Absent draws no time. */
	askedAt?: string;
	/** Groups the radio inputs of one question; must be unique per question. */
	name: string;
	selection: QuestionSelection;
	disabled: boolean;
	/**
	 * The selection is on screen but not going out: the block is declined, which
	 * keeps the picks without sending them. Draws them written-not-sent, the
	 * parked note's look, rather than as a settled answer. Only read while
	 * `disabled`.
	 */
	withheld?: boolean;
	onSelectOption: (label: string) => void;
	onSelectOther: () => void;
	onOtherTextChange: (text: string) => void;
	/**
	 * What the **Other** input holds, picked or not. `selection.otherText` is
	 * null while Other is unpicked, but an editable form keeps the text it
	 * parked there on screen. Absent, the input shows the selection's own text.
	 */
	otherInput?: string;
	/**
	 * The user's remark beside what they picked. Drawn only while it would be
	 * sent (`noteApplies`) on a disabled form, so a record card shows exactly
	 * the note its answer carried.
	 */
	note?: string;
	/** Makes the note editable. Absent, an enabled form offers no note. */
	onNoteChange?: (text: string) => void;
}

/**
 * What the agent wrote — the question and each option's description — is
 * markdown, as everything else it writes is. The colour stays the one this form
 * paints (`prose-inherit-color`, src/index.css). The overflow is local: the
 * answer panel's body is itself a scroller, and a wide code block left to it
 * would slide the whole form sideways, options and all, rather than just
 * itself (see `MarkdownContent`'s `className`).
 *
 * Option labels stay plain text. A label is the answer — sent back verbatim,
 * matched by the server, and shown as-is in the card's collapsed summary — so
 * it reads the same everywhere it appears only if it is never rendered.
 */
const markdownClass = "prose-inherit-color overflow-x-auto break-words";

/**
 * Text that is on screen but will not be sent: a parked note, Other text left
 * behind an unpicked Other, and everything a declined block keeps. One look
 * for "written, not counted" (docs/answering-ui.md §3).
 */
const unsentClass = "border-dashed text-th-text-muted";

/**
 * Every field the user types into while answering, the decline's note in
 * AnswerPanel included. 16px under a thumb because iOS Safari zooms into any
 * field it focuses below that (docs/answering-ui.md §3).
 */
export const answerFieldClass = `rounded bg-th-bg-primary px-2 py-1 pointer-coarse:py-2 text-sm pointer-coarse:text-base placeholder:text-th-text-muted ${inputClass}`;

/**
 * The one and only renderer for a question, used by every surface that draws
 * one: the answer panel's blocks, the record card's read-only body, and the
 * CLI's own blocking prompt. Sharing it is what keeps an answered card looking
 * exactly like the form that was filled in.
 *
 * Three shapes, decided by the question itself (docs/answering-ui.md §3):
 * radios with an **Other** row, checkboxes with one, and — when the question
 * offers no options at all — a textarea with no Other row, because there is
 * nothing for it to be other *than*. That third shape is what a free text
 * request becomes, and it opens three lines tall where the Other input opens
 * at one: the answers that arrive there are paragraphs, while Other is usually
 * a label the agent did not think of — usually, so it grows when it is not.
 */
function QuestionForm({
	question,
	askedAt,
	name,
	selection,
	disabled,
	withheld = false,
	onSelectOption,
	onSelectOther,
	onOtherTextChange,
	otherInput,
	note = "",
	onNoteChange,
}: QuestionFormProps) {
	const hasOptions = question.options.length > 0;
	const inputType = question.multiSelect ? "checkbox" : "radio";
	const otherChecked = selection.otherText !== null;
	const otherValue = otherInput ?? selection.otherText ?? "";
	const selectedCount = selection.labels.length + (otherChecked ? 1 : 0);
	// Unpicked rows recede only beside an answer, to put the eye on it. With
	// nothing picked — a pending, withdrawn or declined record — or with picks
	// that are not going out, there is no answer to point at, and receding would
	// only leave every option hard to read.
	const recede = !withheld && selectedCount > 0;
	// A settled answer is drawn in success, with a tick; one that is kept but
	// not sent is dashed and muted, like a parked note — never both.
	const settled = disabled && !withheld;
	const otherId = useId();

	// The Other input is always on screen in an editable form, so going into it
	// is how the user says "something else" — but only a click or typing does.
	// Focus alone would pick it as Tab passes through on its way to the note,
	// silently replacing a radio already chosen; and a press would pick it as a
	// finger starts a scroll across it. Never unpicks: the radio does that.
	const pickOther = () => {
		if (!otherChecked) onSelectOther();
	};

	const rowClass = (selected: boolean) => {
		// A read-only row is not aimed at, so it owes no hit area; an option the
		// user picks from is the one place in this design a finger lands on a row.
		const reach = disabled ? "" : " pointer-coarse:min-h-11";
		if (disabled) {
			// Selected rows use success (a settled fact) rather than accent
			// (actionable).
			const look = !selected
				? recede
					? "border-th-border/60 opacity-45"
					: "border-th-border"
				: settled
					? "border-th-success bg-th-success/10"
					: "border-dashed border-th-border";
			return `flex cursor-default items-start gap-2 rounded border p-2${reach} ${look}`;
		}
		return `flex cursor-pointer items-start gap-2 rounded border p-2 transition-colors${reach} ${
			selected
				? "border-th-accent bg-th-accent/10"
				: "border-th-border hover:border-th-accent/50"
		}`;
	};

	const choiceTone: ChoiceTone = !disabled
		? "actionable"
		: settled
			? "settled"
			: "withheld";
	// A pick that is not going out mutes its word along with its border.
	const pickedTextClass = (selected: boolean) =>
		disabled && selected && withheld
			? "text-th-text-muted"
			: "text-th-text-primary";

	return (
		<div className="space-y-2">
			<div>
				<div className="flex items-start gap-2">
					{/* A header is the agent's to write and has no length limit, so the
					    chip wraps — inside the row, beside the time — rather than
					    pushing the form wider than the panel. */}
					<span className="min-w-0 break-words rounded bg-th-accent/20 px-1.5 py-0.5 text-xs text-th-text-primary">
						{question.header}
					</span>
					{/* Not "k of n": that reads as a target to reach, and echoes the
					    panel's "k of n ready". Ticked Other counts while still empty —
					    this says what is ticked, not what is ready to send. */}
					{hasOptions && question.multiSelect && selectedCount > 0 && (
						<span className="shrink-0 py-0.5 text-xs tabular-nums text-th-text-muted">
							{selectedCount} selected
						</span>
					)}
					{/* Opposite the chip, in the reader's own locale. It is what tells two
					    questions with the same header apart, and what says how long one
					    has been waiting. */}
					{formatAskedAt(askedAt) && (
						<span className="ml-auto shrink-0 text-xs text-th-text-muted">
							{formatAskedAt(askedAt)}
						</span>
					)}
				</div>
				<MarkdownContent
					content={question.question}
					className={`${markdownClass} mt-1 text-th-text-primary`}
				/>
			</div>

			{hasOptions ? (
				<div className="space-y-1.5">
					{question.options.map((opt) => {
						const selected = selection.labels.includes(opt.label);
						return (
							<label key={opt.label} className={rowClass(selected)}>
								<ChoiceInput
									type={inputType}
									tone={choiceTone}
									name={name}
									checked={selected}
									disabled={disabled}
									onChange={() => onSelectOption(opt.label)}
									className="mt-0.5"
								/>
								<div className="min-w-0 flex-1">
									<div
										className={`break-words text-sm ${pickedTextClass(selected)}`}
									>
										{opt.label}
										{opt.recommended && <RecommendedTag />}
									</div>
									{/* Only when there is one: an option may carry no
									    description at all, and an empty line of its own
									    leading is a gap under every option in the list. */}
									{opt.description && (
										<MarkdownContent
											content={opt.description}
											className={`${markdownClass} text-xs leading-relaxed text-th-text-muted [&_code]:text-[length:inherit]`}
										/>
									)}
								</div>
								{settled && selected && (
									<Check className="mt-0.5 size-3 shrink-0 text-th-success" />
								)}
							</label>
						);
					})}

					{/* Unlike the option rows, only the control and its word are the
					    label. The input beside them is not: a field inside a label is
					    read out as part of the control's name, and a drag that starts
					    in it and ends on the word would toggle Other as a label click. */}
					<div className={rowClass(otherChecked)}>
						<ChoiceInput
							id={otherId}
							type={inputType}
							tone={choiceTone}
							name={name}
							checked={otherChecked}
							disabled={disabled}
							onChange={() => onSelectOther()}
							className="mt-0.5"
						/>
						<div className="min-w-0 flex-1">
							<label
								htmlFor={otherId}
								className={`block text-sm ${pickedTextClass(otherChecked)} ${disabled ? "" : "cursor-pointer"}`}
							>
								Other
							</label>
							{disabled ? (
								otherChecked && (
									// A paragraph rather than the input: a locked input would
									// still scroll after five lines, and a record shows all of it.
									<p
										className={`mt-1 whitespace-pre-wrap break-words rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm ${settled ? "text-th-text-primary" : unsentClass}`}
									>
										{selection.otherText}
									</p>
								)
							) : (
								<TextareaAutosize
									aria-label={
										question.header
											? `Other answer for ${question.header}`
											: "Other answer"
									}
									value={otherValue}
									onClick={pickOther}
									onChange={(e) => {
										onOtherTextChange(e.target.value);
										pickOther();
									}}
									placeholder="Your own answer"
									minRows={1}
									maxRows={5}
									// Text left behind an unpicked Other stays visible but
									// muted, the same as a parked note: it is not sent.
									className={`mt-1 block w-full resize-none ${answerFieldClass} ${
										!otherChecked && otherValue !== ""
											? unsentClass
											: "text-th-text-primary"
									}`}
								/>
							)}
						</div>
						{settled && otherChecked && (
							<Check className="mt-0.5 size-3 shrink-0 text-th-success" />
						)}
					</div>
				</div>
			) : disabled ? (
				// A free-text question with no answer is the ordinary state of a
				// pending, declined or withdrawn card. Drawing the answer box empty
				// would show a filled-in form with nothing in it.
				selection.otherText === null ? (
					<p className="text-xs text-th-text-muted">No answer was given.</p>
				) : (
					<p
						className={`whitespace-pre-wrap break-words rounded border px-2 py-1 text-sm ${
							settled
								? "border-th-success bg-th-success/10 text-th-text-primary"
								: `border-th-border ${unsentClass}`
						}`}
					>
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
					className={`w-full resize-y text-th-text-primary ${answerFieldClass}`}
				/>
			)}
			{hasOptions && (
				<NoteField
					header={question.header}
					note={note}
					applies={noteApplies(question, selection)}
					nothingPicked={selection.labels.length === 0 && !otherChecked}
					disabled={disabled}
					withheld={withheld}
					onChange={onNoteChange}
				/>
			)}
		</div>
	);
}

/**
 * The remark beside an answer, under the options of a question that has them.
 *
 * While the form is editable, text the user typed is never hidden by a change
 * elsewhere in it: unpicking every option leaves a written note on screen,
 * muted and still editable, so it reads as parked rather than lost and can be
 * moved into Other by hand. Only an empty note gives way to the `Add a note`
 * button, and never while it holds the caret. A disabled form draws only a
 * note that would be sent, which is all a record ever carries.
 */
function NoteField({
	header,
	note,
	applies,
	nothingPicked,
	disabled,
	withheld,
	onChange,
}: {
	header: string;
	note: string;
	applies: boolean;
	nothingPicked: boolean;
	disabled: boolean;
	withheld: boolean;
	onChange?: (text: string) => void;
}) {
	// Screen state only: after a reload an empty note is a button again and a
	// written one is already a box, so there is nothing here worth persisting.
	const [opened, setOpened] = useState(false);
	const [focused, setFocused] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const hintId = useId();
	const written = note.trim() !== "";

	// Only the press on `Add a note` sets `opened`, and the box mounts in that
	// same render — the user asked for it to type in. Once open it stays open,
	// so the box coming back after a re-pick does not take the caret again.
	useEffect(() => {
		if (opened) textareaRef.current?.focus();
	}, [opened]);

	// Locking the block swaps the box out from under the caret, and a focused
	// element that is removed fires no blur in every browser — so `focused`
	// would hold an empty box open once the block is unlocked again.
	useEffect(() => {
		if (disabled) setFocused(false);
	}, [disabled]);

	if (disabled || !onChange) {
		if (!applies || !written) return null;
		return (
			<div className="space-y-1">
				<NoteLabel />
				<p
					className={`whitespace-pre-wrap break-words rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm ${
						withheld ? unsentClass : "text-th-text-primary"
					}`}
				>
					{note}
				</p>
			</div>
		);
	}

	if (!written && !focused && !(opened && applies)) {
		if (!applies) return null;
		// The box itself is the hit area — 36px under a mouse, 44px under a thumb
		// — rather than an overlay around a 16px line: the rows above and below
		// are 8px away, and an overlay of either height would reach into them.
		return (
			<button
				type="button"
				onClick={() => setOpened(true)}
				className="flex min-h-9 items-center gap-1 rounded pointer-coarse:min-h-11 text-xs text-th-accent transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			>
				<Plus className="size-3.5" />
				Add a note
			</button>
		);
	}

	const parked = written && !applies;
	return (
		<div className="space-y-1">
			<NoteLabel />
			<TextareaAutosize
				ref={textareaRef}
				aria-label={header ? `Note for ${header}` : "Note"}
				// The dashed border is the only other sign it will not be sent.
				aria-describedby={parked ? hintId : undefined}
				value={note}
				onChange={(e) => onChange(e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				placeholder="Anything the agent should know about this choice"
				minRows={2}
				maxRows={5}
				className={`block w-full resize-none ${answerFieldClass} ${
					parked ? unsentClass : "text-th-text-primary"
				}`}
			/>
			{parked && (
				<p id={hintId} className="text-xs text-th-text-muted">
					{nothingPicked
						? "Not sent until you pick an option."
						: "Not sent with Other — add it to your answer above."}
				</p>
			)}
		</div>
	);
}

function NoteLabel() {
	return <div className="text-xs text-th-text-muted">Note</div>;
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
