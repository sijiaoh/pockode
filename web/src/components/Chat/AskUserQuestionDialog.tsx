import { useEffect, useRef, useState } from "react";
import type { AskUserQuestionRequest } from "../../types/message";

interface Props {
	request: AskUserQuestionRequest;
	onSubmit: (answers: Record<string, string>) => void;
	onCancel: () => void;
}

function AskUserQuestionDialog({ request, onSubmit, onCancel }: Props) {
	const submitButtonRef = useRef<HTMLButtonElement>(null);
	// answers: question text -> selected label(s) or "Other: custom text"
	const [answers, setAnswers] = useState<Record<string, string>>({});
	// Track which questions have "Other" selected
	const [otherSelected, setOtherSelected] = useState<Record<string, boolean>>(
		{},
	);
	// Track custom text for "Other" options
	const [otherText, setOtherText] = useState<Record<string, string>>({});

	useEffect(() => {
		submitButtonRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onCancel();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [onCancel]);

	const handleOptionSelect = (
		questionText: string,
		label: string,
		multiSelect: boolean,
	) => {
		if (multiSelect) {
			// In multiSelect mode, don't clear Other when selecting regular options
			setAnswers((prev) => {
				const current = prev[questionText] || "";
				const labels = current ? current.split(", ") : [];
				const index = labels.indexOf(label);
				if (index >= 0) {
					labels.splice(index, 1);
				} else {
					labels.push(label);
				}
				return { ...prev, [questionText]: labels.join(", ") };
			});
		} else {
			// In single-select mode, clear Other when selecting a regular option
			setOtherSelected((prev) => ({ ...prev, [questionText]: false }));
			setAnswers((prev) => ({ ...prev, [questionText]: label }));
		}
	};

	const handleOtherSelect = (questionText: string, multiSelect: boolean) => {
		if (multiSelect) {
			// In multiSelect mode, toggle Other without clearing regular options
			setOtherSelected((prev) => ({
				...prev,
				[questionText]: !prev[questionText],
			}));
		} else {
			// In single-select mode, clear regular options when selecting Other
			setOtherSelected((prev) => ({ ...prev, [questionText]: true }));
			setAnswers((prev) => ({ ...prev, [questionText]: "" }));
		}
	};

	const handleOtherTextChange = (questionText: string, text: string) => {
		setOtherText((prev) => ({ ...prev, [questionText]: text }));
	};

	const handleSubmit = () => {
		const finalAnswers: Record<string, string> = {};
		for (const q of request.questions) {
			if (q.multiSelect) {
				// In multiSelect mode, combine regular options and Other
				const parts: string[] = [];
				if (answers[q.question]) {
					parts.push(answers[q.question]);
				}
				if (otherSelected[q.question] && otherText[q.question]?.trim()) {
					parts.push(`Other: ${otherText[q.question]}`);
				}
				finalAnswers[q.question] = parts.join(", ");
			} else {
				// In single-select mode, use either Other or regular answer
				if (otherSelected[q.question]) {
					finalAnswers[q.question] = `Other: ${otherText[q.question] || ""}`;
				} else {
					finalAnswers[q.question] = answers[q.question] || "";
				}
			}
		}
		onSubmit(finalAnswers);
	};

	const isOptionSelected = (
		questionText: string,
		label: string,
		multiSelect: boolean,
	): boolean => {
		// In single-select mode, Other and regular options are mutually exclusive
		if (!multiSelect && otherSelected[questionText]) return false;
		const answer = answers[questionText] || "";
		if (multiSelect) {
			const labels = answer.split(", ");
			return labels.includes(label);
		}
		return answer === label;
	};

	const canSubmit = request.questions.every((q) => {
		if (q.multiSelect) {
			// In multiSelect mode, need at least one option or Other with text
			const hasRegularOption = (answers[q.question] || "").length > 0;
			const hasOtherWithText =
				otherSelected[q.question] &&
				(otherText[q.question] || "").trim().length > 0;
			return hasRegularOption || hasOtherWithText;
		}
		// In single-select mode
		if (otherSelected[q.question]) {
			return (otherText[q.question] || "").trim().length > 0;
		}
		return (answers[q.question] || "").length > 0;
	});

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-th-bg-overlay"
			role="dialog"
			aria-modal="true"
			aria-labelledby="question-dialog-title"
		>
			<div className="mx-4 max-h-[80vh] w-full max-w-lg overflow-hidden rounded-lg bg-th-bg-secondary shadow-xl">
				<div className="border-b border-th-border p-4">
					<h2
						id="question-dialog-title"
						className="text-lg font-semibold text-th-text-primary"
					>
						Question
					</h2>
					<p className="mt-1 text-sm text-th-text-muted">
						Please answer the following question(s) to continue.
					</p>
				</div>

				<div className="max-h-[50vh] overflow-y-auto p-4 space-y-6">
					{request.questions.map((q) => (
						<div key={q.question} className="space-y-3">
							<div>
								<span className="inline-block rounded bg-th-accent/20 px-2 py-0.5 text-xs font-medium text-th-accent">
									{q.header}
								</span>
								<p className="mt-1 text-sm text-th-text-primary">
									{q.question}
								</p>
							</div>

							<div className="space-y-2">
								{q.options.map((opt) => (
									<label
										key={opt.label}
										className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
											isOptionSelected(q.question, opt.label, q.multiSelect)
												? "border-th-accent bg-th-accent/10"
												: "border-th-border hover:border-th-accent/50"
										}`}
									>
										<input
											type={q.multiSelect ? "checkbox" : "radio"}
											name={q.question}
											checked={isOptionSelected(
												q.question,
												opt.label,
												q.multiSelect,
											)}
											onChange={() =>
												handleOptionSelect(q.question, opt.label, q.multiSelect)
											}
											className="mt-0.5 accent-th-accent"
										/>
										<div className="flex-1">
											<div className="text-sm font-medium text-th-text-primary">
												{opt.label}
											</div>
											<div className="text-xs text-th-text-muted">
												{opt.description}
											</div>
										</div>
									</label>
								))}

								{/* Other option */}
								<label
									className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
										otherSelected[q.question]
											? "border-th-accent bg-th-accent/10"
											: "border-th-border hover:border-th-accent/50"
									}`}
								>
									<input
										type={q.multiSelect ? "checkbox" : "radio"}
										name={q.question}
										checked={otherSelected[q.question] || false}
										onChange={() =>
											handleOtherSelect(q.question, q.multiSelect)
										}
										className="mt-0.5 accent-th-accent"
									/>
									<div className="flex-1">
										<div className="text-sm font-medium text-th-text-primary">
											Other
										</div>
										{otherSelected[q.question] && (
											<input
												type="text"
												value={otherText[q.question] || ""}
												onChange={(e) =>
													handleOtherTextChange(q.question, e.target.value)
												}
												placeholder="Enter your answer..."
												className="mt-2 w-full rounded border border-th-border bg-th-bg-primary px-2 py-1 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent focus:outline-none"
											/>
										)}
									</div>
								</label>
							</div>
						</div>
					))}
				</div>

				<div className="flex justify-end gap-3 border-t border-th-border p-4">
					<button
						type="button"
						onClick={onCancel}
						className="rounded-lg bg-th-bg-tertiary px-4 py-2 text-sm font-medium text-th-text-primary transition-colors hover:opacity-90"
					>
						Cancel
					</button>
					<button
						ref={submitButtonRef}
						type="button"
						onClick={handleSubmit}
						disabled={!canSubmit}
						className="rounded-lg bg-th-accent px-4 py-2 text-sm font-medium text-th-accent-text transition-colors hover:bg-th-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
					>
						Submit
					</button>
				</div>
			</div>
		</div>
	);
}

export default AskUserQuestionDialog;
